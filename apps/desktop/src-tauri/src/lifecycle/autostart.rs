//! 开机自启 —— Windows 的 Run 注册表键
//!
//! 为什么是自己写而不是引 `tauri-plugin-autostart`：
//!  1. 本 Shell 已经直接依赖 `windows` crate（窗口样式、钩子、DPI），
//!     注册表只是多开一个 feature，不引入第三方依赖；
//!  2. 插件要在.capabilities 里配权限、前端再装一个 npm 包，
//!     而这里面板连注册表这个概念都不需要知道 —— 它只知道一个布尔值。
//!  3. 桌宠是**纯 Windows** 目标（见 §2.2 兼容性矩阵），跨平台抽象换不来东西。
//!
//! 选 Run 键而不是任务计划：
//!  Run 键不需要提权（HKCU）、不需要处理触发器与凭据，用户到
//!  「设置 → 应用 → 启动」里也能直接看到并关掉它 —— 对"可选"功能来说，
//!  能被用户反向找到是必须项。代价是没有提权/延迟启动等能力，
//!  桌宠一个常驻桌面的普通应用用不上那些。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use crate::logging::log_warn;
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_SZ,
};

/// Run 键路径（当前用户）。
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// 键值名。与窗口标题、托盘 tooltip 保持一致，用户在系统设置里看到的就是它。
const VALUE_NAME: &str = "Heart Star";

/// 当前是否已设为开机自启。
///
/// 判定只看**键值是否存在**，不比对里面的路径：
/// 用户可能在别处手动改过这一条，或者 exe 换过位置（卸载重装、切换安装目录），
/// 这些情况"已设置"依然是事实，UI 就该显示已设置。
pub fn auto_launch_enabled() -> bool {
    match read_value() {
        Ok(Some(command)) => !command.is_empty(),
        Ok(None) => false,
        Err(e) => {
            // 读不出来当作"没开启"，但必须留痕：失败若被静默吞掉，
            // 事后只剩"到底设没设上"这种再也答不上来的问题
            log_warn!("开机自启状态读取失败: {e}");
            false
        }
    }
}

/// 开启 / 关闭开机自启。成功与否都如实返回。
///
/// 失败不上抛给 UI：面板只需要知道最终状态（`auto_launch_enabled`），
/// 由调用方把回读结果下发下去即可 —— 勾选框会自己拨回去。
pub fn set_auto_launch(enabled: bool) -> Result<(), String> {
    // dev 下 current_exe 指向 target\debug 下的可执行文件，
    // 注册上去的是那份 —— 这正是验证本功能需要的行为，但要让用户知道。
    let exe = std::env::current_exe().map_err(|e| format!("取不到可执行文件路径: {e}"))?;

    let key = open_key(true)?;
    let result = if enabled {
        write_command(&key, &exe)
    } else {
        delete_value(key)
    };
    // HKEY 不是 RAII 句柄，每个出口都得自己关
    let _ = unsafe { RegCloseKey(key) };
    result
}

/// 打开 Run 键。`writable = true` 时用读写权限。
fn open_key(writable: bool) -> Result<HKEY, String> {
    let rights = if writable { KEY_WRITE } else { KEY_READ };
    let subkey = wide(RUN_KEY);

    let mut key = HKEY::default();
    // ulOptions 被 windows-rs 包成了 Option —— 传 None 就是"取缺省"
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            rights,
            &mut key,
        )
    };
    status
        .ok()
        .map_err(|e| format!("打开 Run 键失败: {e}"))
        .map(|()| key)
}

/// 写入命令行。
fn write_command(key: &HKEY, exe: &std::path::Path) -> Result<(), String> {
    // 路径一律加引号：安装目录带空格是常态（Program Files 自身就是），
    // 不该让"路径里有没有空格"成为一个隐藏的前提条件。
    let command = format!("\"{}\"", exe.display());
    let bytes = wide_bytes(&command);
    let name = wide(VALUE_NAME);

    // REG_SZ 的结尾 \0 必须算进 cbData，否则读回来会多出一个乱码字符。
    // wide_bytes 已经带上它，所以这里直接整块提交。
    let status = unsafe { RegSetValueExW(*key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&bytes)) };
    status.ok().map_err(|e| format!("写入 Run 键失败: {e}"))
}

/// 删除键值。值不存在也算成功 —— 幂等，用户连点两下不会报错。
fn delete_value(key: HKEY) -> Result<(), String> {
    let name = wide(VALUE_NAME);
    let status = unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) };
    match status.ok() {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => Ok(()),
        Err(e) => Err(format!("删除 Run 键值失败: {e}")),
    }
}

/// 读出自启命令行。不存在返回 `Ok(None)`。
fn read_value() -> Result<Option<String>, String> {
    let key = open_key(false)?;
    let name = wide(VALUE_NAME);

    // 两趟调用是 RegQueryValueExW 的固定套路：先问长度，再按长度取数据。
    // 拍脑袋定一个缓冲区大小的话，长路径会被截成一段没有意义的前缀。
    let mut value_type = REG_SZ;
    let mut size: u32 = 0;
    let probe = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut value_type),
            None,
            Some(&mut size),
        )
    };

    let finish = |result: Result<Option<String>, String>| -> Result<Option<String>, String> {
        let _ = unsafe { RegCloseKey(key) };
        result
    };

    match probe.ok() {
        Ok(()) => {}
        Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return finish(Ok(None)),
        Err(e) => return finish(Err(format!("查询 Run 键值失败: {e}"))),
    }

    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if let Err(e) = status.ok() {
        return finish(Err(format!("读取 Run 键值失败: {e}")));
    }

    // 剪掉结尾的 \0；REG_SZ 的 cbData 可能把它算进去，也可能不算
    let units = buffer
        .chunks_exact(2)
        .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect::<Vec<u16>>();

    finish(Ok(Some(String::from_utf16_lossy(&units))))
}

/// 转成带结尾 \0 的 UTF-16，供 PCWSTR 使用。
fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// REG_SZ 的字节负载，含结尾 \0。
fn wide_bytes(text: &str) -> Vec<u8> {
    wide(text)
        .into_iter()
        .flat_map(|unit| unit.to_ne_bytes())
        .collect()
}
