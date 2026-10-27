//! Heart Star 壳层
//!
//! 职责：窗口生命周期、形态切换、鼠标钩子、托盘、快捷键、更新、看门狗。
//! 禁止：感知角色种类、渲染实现、AI 逻辑。

mod logging;
mod settings;

pub mod ipc;
pub mod lifecycle;
pub mod window;

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::HWND;

use logging::{log, log_warn};
use window::{host, Form};

/// 形态监管的轮询间隔。宿主是否还活着只能靠轮询——
/// 它是外部进程的窗口，不会主动通知我们。250ms 足够快，开销可忽略。
const SUPERVISOR_INTERVAL: Duration = Duration::from_millis(250);

/// 面板窗口。dev 走面板自己的 vite（5174），生产走 frontendDist 下的子目录。
///
/// 为什么这两个地址不能写进 `tauri.conf.json`：
/// 配置文件里的 `url` 只有一个值，没法按 dev / 生产分开。而两个前端的
/// dev server 端口不同、产物位置也不同，只能在代码里按 `is_dev()` 分支。
const PANEL_LABEL: &str = "panel";
const PANEL_DEV_URL: &str = "http://localhost:5174/";
const PANEL_PROD_PATH: &str = "panel/index.html";
const PANEL_WIDTH: f64 = 900.0;
const PANEL_HEIGHT: f64 = 640.0;

pub fn run() {
    // DPI 感知必须在创建任何窗口之前设定，否则系统会对整个窗口做位图拉伸：
    // 内容模糊，且命中判定与窗口矩形错位。
    if !window::dpi::enable_per_monitor_v2() {
        log_warn!("未启用 Per-Monitor V2 DPI 感知，混合缩放屏下窗口会模糊");
    }

    tauri::Builder::default()
        .setup(|app| {
            // 宠物窗口在 tauri.conf.json 中定义（label = "pet"）。
            //
            // 为什么不用 WebviewWindowBuilder 动态创建：
            // 实测 Builder 的 .transparent(true) 没有作用到 WebView2 控件层——
            // 窗口本身透明了，但页面透明后透出的是 WebView2 默认的白色背景，
            // 表现为窗口顶部一大片白。写在配置里由 Tauri 在窗口创建源头应用，
            // 才能连 WebView2 背景一起透明。
            let pet = app
                .get_webview_window("pet")
                .expect("tauri.conf.json 中应配置 label=pet 的窗口");

            // 接管 HWND：应用桌面形态样式（穿透 / 不进任务栏 / 不抢焦点）、
            // 子类化窗口过程（拦截 WM_NCACTIVATE 等非客户区绘制）并挂钩子
            let hwnd = pet.hwnd()?;
            let mut pet_window = window::PetWindow::new(hwnd);
            if let Err(e) = pet_window.init() {
                log_warn!("窗口样式应用失败: {e}");
            }
            if pet_window.hook_installed() {
                log!("鼠标钩子已安装");
            } else {
                log_warn!("鼠标钩子未安装，宠物将始终穿透（不可交互）");
            }
            log!("DPI 缩放 {:.0}%", pet_window.renderer_scale() * 100.0);

            // 帧率档位：从磁盘读出上一次用户的取舍，挂成共享状态。
            // 面板改档位时改的是同一份，监管线程每秒读它，所以改动一秒内生效。
            let initial = settings::load(app.handle());
            log!(
                "帧率档位：交互 {:.0}fps / 空闲 {:.0}fps",
                initial.active_fps,
                initial.idle_fps
            );
            let frame_profile = Arc::new(Mutex::new(initial));
            app.manage(frame_profile.clone());

            // 监听渲染层事件，并接管帧预算（空闲降帧）
            ipc::bind(&pet);
            ipc::spawn_frame_budget_governor(pet.clone(), frame_profile.clone());
            ipc::spawn_gaze_pump(pet.clone());
            ipc::spawn_tap_pump(pet.clone());

            // 宠物窗口落位诊断。桌宠没有窗口边框也没有任务栏入口，
            // "看不见宠物"时最需要的信息就是它到底在哪、多大、可见与否。
            let r = host::current_rect(hwnd);
            log!(
                "宠物窗口 x={} y={} {}x{} 可见={}",
                r.x,
                r.y,
                r.width,
                r.height,
                host::is_visible(hwnd)
            );

            // 面板**不在启动路径上创建**：它要初始化第二个 WebView2，
            // dev 下还要等第二个 vite 就绪，两段开销都会卡住主线程（实测数秒）。
            // 挪到后台线程，就绪后再回主线程建窗口。
            spawn_panel_bootstrap(app.handle().clone());

            // 托盘：桌宠没有常规窗口外壳，这是唯一常驻的可发现入口
            if let Err(e) = lifecycle::setup_tray(app.handle()) {
                log_warn!("托盘创建失败: {e}");
            }

            // 交给主进程托管 —— 后续所有形态切换都经过这个状态机，
            // 业务代码不得直接操作窗口。
            // 包一层 Mutex 是因为切换需要 `&mut`：状态机托管在 Tauri 里
            // 只能拿到共享引用，而形态切换本质上就是可变状态迁移。
            app.manage(Mutex::new(pet_window));

            spawn_form_supervisor(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Heart Star 启动失败");
}

/// 面板窗口。刻意**不在 `tauri.conf.json` 里声明**：dev 与生产要加载的地址不同，
/// 而配置里的 `url` 只有一个值（原因见上面的常量注释）。
fn build_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let url = if tauri::is_dev() {
        WebviewUrl::External(PANEL_DEV_URL.parse().expect("面板 dev 地址应可解析"))
    } else {
        WebviewUrl::App(PANEL_PROD_PATH.into())
    };

    WebviewWindowBuilder::new(app, PANEL_LABEL, url)
        .title("Heart Star")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .visible(false)
        .build()
}

/// 后台准备面板窗口，就绪后回主线程创建。
///
/// 两段时间都不能占主线程：
///
/// 1. dev 下等第二个 vite —— 首次预打包 React 要好几秒
/// 2. 初始化第二个 WebView2 —— 又是几百毫秒
///
/// 放在 `setup()` 里同步做会连宠物窗口一起冻住（它也得靠主线程绘制）。
fn spawn_panel_bootstrap(app: AppHandle) {
    std::thread::spawn(move || {
        if tauri::is_dev() {
            wait_for_panel_dev_server();
        }

        let handle = app.clone();
        let created = app.run_on_main_thread(move || match build_panel_window(&handle) {
            Ok(panel) => {
                intercept_panel_close(&panel);
                ipc::panel::bind(&panel);
                log!("面板窗口已就绪（托盘菜单 → 打开面板）");
            }
            Err(e) => log_warn!("面板窗口创建失败: {e}"),
        });

        if let Err(e) = created {
            log_warn!("面板创建任务派发失败: {e}");
        }
    });
}

/// dev 下等面板的 vite 起来。
///
/// Tauri 只会等 `devUrl`（renderer 的 5173），面板的 5174 没人等。
/// 面板窗口若先于 vite 就绪就加载，会得到一张空白页 —— 而这个现象的原因
/// 完全看不出来，排查起来非常浪费时间。只在 dev 下等，生产走本地文件没有这个问题。
fn wait_for_panel_dev_server() {
    // PANEL_DEV_URL 形如 http://localhost:5174/，取主机与端口拼成可连接的地址
    // PANEL_DEV_URL 形如 http://localhost:5174/，这里取 "localhost:5174"
    let Some(addr) = PANEL_DEV_URL
        .trim_start_matches("http://")
        .split('/')
        .next()
    else {
        return;
    };

    // 两个坑，都在下面一并处理：
    //  1. `TcpStream::connect` **没有超时**，SYN 被丢弃时会一直阻塞 ——
    //     "等就绪"会变成永久挂起，日志上只看到"开始"再无下文，极难定位。
    //  2. 必须逐个解析出的地址都试：`localhost` 在部分机器上解析到 ::1，
    //     而 vite 只监听其中一个族，写死 127.0.0.1 会一直连不上。
    let probe = Duration::from_millis(500);
    let mut last = String::from("未知原因");
    for _ in 0..40 {
        if let Ok(addrs) = addr.to_socket_addrs() {
            for target in addrs {
                match TcpStream::connect_timeout(&target, probe) {
                    Ok(_) => return,
                    Err(e) => last = format!("{target} → {e}"),
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    log_warn!("面板 dev server 未就绪（{PANEL_DEV_URL}）：{last}");
}

/// 关面板 = 隐藏，而不是销毁。
///
/// 销毁后每次打开都要重新初始化一个 WebView2，冷启动几百毫秒，
/// 每次开面板都付一遍不划算。代价是"宿主还在但看不见"，
/// 所以状态机必须同时看 `host::is_visible`（见 `PetWindow::ensure_valid`）。
fn intercept_panel_close(panel: &WebviewWindow) {
    let p = panel.clone();
    panel.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = p.hide();
        }
    });
}

/// 上一次已下发给渲染层的壳侧状态。用来判断是否需要重发，免得每 250ms 空刷一遍 IPC。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SyncedState {
    form: Form,
    /// 缩放系数 × 1000。用整数毫倍而不是 f64：浮点直接当状态比较会有精度噪声，
    /// 那会导致每轮都被判成"变了"，白白重发。
    scale_milli: u32,
}

/// 形态监管线程。
///
/// 三个职责，都是"低频轮询 + 走状态机"，绝不在别处直接调 SetParent：
///  1. 宿主是否还活着 —— 宿主是外部窗口，销毁不会通知我们，只能轮询。
///     漏掉这个检测，宠物会永远卡在面板形态里叫不回来。
///  2. 托盘菜单触发的切换请求（钩子置位，这里判定、主线程执行）。
///  3. 把形态与缩放同步给渲染层。
///
/// 本线程只**判定**，不碰窗口：真正的窗口操作由 `dispatch_window_work` 派给主线程。
fn spawn_form_supervisor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut synced: Option<SyncedState> = None;

        loop {
            std::thread::sleep(SUPERVISOR_INTERVAL);

            dispatch_window_work(&app);

            // 状态同步只读不写窗口，留在监管线程即可
            let managed = app.state::<Mutex<window::PetWindow>>();
            let locked = managed.lock();
            match &locked {
                Ok(pet) => sync_renderer(&app, pet, &mut synced),
                Err(e) => log_warn!("形态监管：状态机加锁失败: {e}"),
            }
        }
    });
}

/// 这一轮要主线程做的窗口工作。
#[derive(Debug, Clone, Copy)]
enum WindowWork {
    /// 挂载进面板
    ToPanel,
    /// 回到桌面
    ToDesktop,
    /// 宿主失效，强制回落
    Fallback,
}

/// 主线程是否还有未完成的工作。主线程单次任务是原子的，没跑完就不再叠
/// 一次任务上去——两个形态切换并发会把宠物搬丢。
static WINDOW_WORK_BUSY: AtomicBool = AtomicBool::new(false);

/// 判定这一轮要做什么，然后派给主线程执行。
///
/// **为什么必须派回主线程**：Win32 窗口属于创建它的线程，形态切换还要装/卸
/// `WH_MOUSE_LL` 钩子，而低层钩子只在"安装它的那个线程取消息时"才会回调。
/// 监管线程没有消息循环，在这里装钩子等于把钩子彻底闷死 ——
/// 表现为切回桌面之后宠物既不响应点击、连穿透都不会再摘掉，
/// 而且日志毫无痕迹，只能靠"宠物突然变砖"才发现。
fn dispatch_window_work(app: &AppHandle) {
    let Ok(work) = judged_work(app) else {
        return;
    };

    if WINDOW_WORK_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    // 两份句柄各司其职：派发给 `handle`，闭包里用的是 `worker`。
    // 同一个 AppHandle 既被借用派发又被 move 进闭包，编译器不会放行。
    let handle = app.clone();
    let worker = app.clone();
    let dispatched = handle.run_on_main_thread(move || {
        run_window_work(&worker, work);
        WINDOW_WORK_BUSY.store(false, Ordering::SeqCst);
    });

    if dispatched.is_err() {
        WINDOW_WORK_BUSY.store(false, Ordering::SeqCst);
        log_warn!("形态任务派发失败");
    }
}

/// 只读判定本轮是否有活干。刻意不在这里做任何窗口写操作。
fn judged_work(app: &AppHandle) -> Result<WindowWork, ()> {
    let managed = app.state::<Mutex<window::PetWindow>>();
    let pet = managed.lock().map_err(|_| ())?;

    // 宿主失效优先于用户的切换请求：先救回宠物再谈别的
    if host_lost(&pet) {
        return Ok(WindowWork::Fallback);
    }

    if window::hook::take_toggle_request() {
        match pet.form() {
            Form::Desktop => Ok(WindowWork::ToPanel),
            Form::Panel(_) => Ok(WindowWork::ToDesktop),
            // 切换进行中：丢弃这次请求，下一次点菜单会重新触发
            Form::Transitioning => Err(()),
        }
    } else {
        Err(())
    }
}

/// 宿主是否失效。只读判定，不做任何恢复动作。
fn host_lost(pet: &window::PetWindow) -> bool {
    match pet.form() {
        Form::Panel(host) => !host::is_alive(host) || !host::is_visible(host),
        _ => false,
    }
}

/// 真正的窗口操作。只在主线程执行。
fn run_window_work(app: &AppHandle, work: WindowWork) {
    let managed = app.state::<Mutex<window::PetWindow>>();
    let mut pet = match managed.lock() {
        Ok(guard) => guard,
        Err(e) => {
            log_warn!("形态切换：状态机加锁失败: {e}");
            return;
        }
    };

    let result = match work {
        WindowWork::Fallback => Some(pet.ensure_valid()),
        WindowWork::ToDesktop => Some(pet.to_desktop()),
        WindowWork::ToPanel => match panel_hwnd(app) {
            Some(host) => {
                // 面板默认是隐藏的，必须先显示**再**迁移：
                // 挂在隐藏窗口上的宠物等于跟着一起消失。
                show_panel(app);
                let rect = host::current_rect(pet.hwnd());
                let area = centered_in(host, rect.width, rect.height);
                Some(pet.to_panel(host, area))
            }
            // 面板还在后台准备（第二个 WebView2 初始化 + dev 下等 vite）。
            // 这一轮做不到，直接告知用户 —— 静默丢弃会让人以为菜单点了没反应。
            None => {
                log_warn!("面板尚未就绪，本次切换请求已丢弃");
                None
            }
        },
    };

    if let Some(result) = result {
        match result {
            Ok(()) => log!("形态 -> {:?}", pet.form()),
            Err(e) => log_warn!("形态切换失败: {e}"),
        }
    }
}

/// 把壳侧的形态与缩放同步给渲染层。
///
/// 为什么放在这里、而不是在切换动作里直接发：窗口过程（`WM_DPICHANGED`）与
/// 状态机都只握着 HWND，拿不到 `WebviewWindow`，发不出 IPC。这里是唯一同时
/// 握着两者的地方，顺带把"形态变了"和"DPI 变了"两条路径收敛成一次下发。
fn sync_renderer(app: &AppHandle, pet: &window::PetWindow, last: &mut Option<SyncedState>) {
    let Some(form) = ipc::to_protocol(pet.form()) else {
        // 切换进行中，形态未定，这一轮不下发
        return;
    };

    let current = SyncedState {
        form: pet.form(),
        scale_milli: (pet.renderer_scale() * 1000.0).round() as u32,
    };
    if *last == Some(current) {
        return;
    }
    let form_changed = last.as_ref().map(|s| s.form) != Some(current.form);
    *last = Some(current);

    let Some(window) = app.get_webview_window("pet") else {
        return;
    };

    // 置顶要跟着形态走：桌面形态得浮在其他窗口之上；进了面板就必须让位，
    // 子窗口带 TOPMOST 会让 Z 序表现异常（可能盖住面板自己的 UI）。
    if form_changed {
        let _ = window.set_always_on_top(matches!(current.form, Form::Desktop));
    }

    ipc::announce(&window, form);
}

/// 面板窗口的句柄。面板是后台异步创建的，可能还没就绪，所以每次现查。
fn panel_hwnd(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window(PANEL_LABEL)?.hwnd().ok()
}

/// 显示面板。入口有两类：托盘菜单，或形态切换时顺带显示。
pub(crate) fn show_panel(app: &AppHandle) {
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let _ = panel.show();
    let _ = panel.set_focus();
    // 每次显示都补发一次角色列表：面板页面可能被 HMR 重载，
    // 只在 ready 时发一次的话重载后按钮就没了
    ipc::panel::send_character_list(app);
    // 开机自启同理 —— 而且它的真相在注册表里，用户可以在系统设置里改，
    // 每次都重读一次才能跟上外部改动
    ipc::panel::send_autostart_state(app);
    // 帧率档位同理：面板页面重载后滑块要能拿回当前正在跑的两个值
    ipc::panel::send_frame_profile(app);
}

/// 把宠物摆到宿主客户区中央。
///
/// 坐标是**物理像素**：子窗口的 SetWindowPos 坐标相对父窗口客户区，
/// 在 Per-Monitor V2 下这个值不经过 DPI 虚拟化。
fn centered_in(host: HWND, width: i32, height: i32) -> host::Rect {
    let (client_w, client_h) = host::client_size(host);
    host::Rect {
        x: ((client_w - width) / 2).max(0),
        y: ((client_h - height) / 2).max(0),
        width,
        height,
    }
}
