//! 用户偏好持久化
//!
//! 落在 app data 目录的一个 JSON 文件里。为什么是这么粗糙的形式：
//! 目前只有两个数值要记（两个帧率档位），为此引入 `tauri-plugin-store`
//! 或一套 sqlite 属于典型的过度工程 —— 它带来的依赖与概念，比要解决的问题
//! 本身还多。等偏好项多到需要事务/迁移时再换，那时候怎么换都不影响调用点。
//!
//! 读失败一律退回默认值：**读不出偏好不能让程序起不来**。
//! 写失败只记警告：偏好没存上只影响下次启动的初值，不影响本次使用体验。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::logging::log_warn;

/// 默认值与 TS 侧 `FRAME_PROFILE` 的 default 一致。
///
/// 这是本文件里唯一一处"两边各写一份"的数字：策略 fix 消息不同，
/// 偏好默认值没有生成器可用，所以末尾用一组测试把它钉住。
const DEFAULT_ACTIVE_FPS: f64 = 60.0;
const DEFAULT_IDLE_FPS: f64 = 15.0;

/// 允许的范围，对应 TS 侧 `FRAME_PROFILE.active.min` 与 `.max`。
///
/// 这是最后一道防线：越界值一旦落盘，下次解锁也跟着错。
const MIN_FPS: f64 = 5.0;
const MAX_FPS: f64 = 60.0;

/// 帧率档位 —— 用户对"性能 vs 功耗"的取舍。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FrameProfile {
    /// 有交互时的帧率上限
    pub active_fps: f64,
    /// 空闲一段时候降到的帧率
    pub idle_fps: f64,
}

impl FrameProfile {
    pub fn default_profile() -> Self {
        Self {
            active_fps: DEFAULT_ACTIVE_FPS,
            idle_fps: DEFAULT_IDLE_FPS,
        }
    }

    /// 夹紧到合法区间。
    ///
    /// 非有限值（NaN / 无穷）也一并处理：IPC 过来的是 JSON 数字，
    /// 面板可能在输入框里算出 NaN 之类的东西，照单全收会污染持久化文件。
    pub fn clamp(&self) -> Self {
        let active = clamp_fps(self.active_fps);
        let idle = clamp_fps(self.idle_fps);
        // 空闲档不该高于活跃档：那样会变成"越闲跑得越快"，违反降帧的本意。
        // 这里不做悄悄交换（用户会看不懂自己的设置为什么变了），
        // 而是把空闲档压到活跃档 —— 保住这一条语义底线。
        Self {
            active_fps: active,
            idle_fps: idle.min(active),
        }
    }
}

fn clamp_fps(value: f64) -> f64 {
    // NaN / 无穷先挡掉：clamp 对 NaN 的输入返回的还是 NaN，
    // 那会让偏好文件里存进一个非法的 JSON 数字
    if !value.is_finite() {
        return DEFAULT_IDLE_FPS;
    }
    value.clamp(MIN_FPS, MAX_FPS)
}

const FILE_NAME: &str = "settings.json";

/// 读出偏好。读不到就用默认值 —— 首次启动、文件损坏都是这条路径。
pub fn load(app: &AppHandle) -> FrameProfile {
    let Ok(dir) = app.path().app_data_dir() else {
        log_warn!("取不到 app data 目录，帧率偏好退回默认值");
        return FrameProfile::default_profile();
    };
    let path = dir.join(FILE_NAME);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return FrameProfile::default_profile();
    };
    match serde_json::from_str::<FrameProfile>(&text) {
        Ok(profile) => profile.clamp(),
        Err(e) => {
            log_warn!("偏好文件解析失败（{}），退回默认值: {e}", path.display());
            FrameProfile::default_profile()
        }
    }
}

/// 落盘。失败只记警告 —— 偏好没存上只影响下次启动的初值。
pub fn save(app: &AppHandle, profile: &FrameProfile) {
    let Ok(dir) = app.path().app_data_dir() else {
        log_warn!("取不到 app data 目录，帧率偏好未保存");
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log_warn!("创建 {} 失败，帧率偏好未保存: {e}", dir.display());
        return;
    }

    let path = dir.join(FILE_NAME);
    match serde_json::to_string_pretty(profile) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                log_warn!("写入 {} 失败，帧率偏好未保存: {e}", path.display());
            }
        }
        Err(e) => log_warn!("偏好序列化失败: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认值与协议常量一致() {
        let p = FrameProfile::default_profile();
        assert_eq!(p.active_fps, 60.0);
        assert_eq!(p.idle_fps, 15.0);
    }

    #[test]
    fn 越界值被夹回区间() {
        let p = FrameProfile {
            active_fps: 240.0,
            idle_fps: 0.0,
        }
        .clamp();
        assert_eq!(p.active_fps, MAX_FPS);
        assert_eq!(p.idle_fps, MIN_FPS);
    }

    #[test]
    fn 空闲档不高于活跃档() {
        // 用户把"空闲后"调得比"有交互时"还高时，不能照单全收 ——
        // 那会变成越闲跑得越快，与降帧的本意相反
        let p = FrameProfile {
            active_fps: 30.0,
            idle_fps: 60.0,
        }
        .clamp();
        assert_eq!(p.active_fps, 30.0);
        assert_eq!(p.idle_fps, 30.0);
    }

    #[test]
    fn 非有限值不会污染偏好() {
        let p = FrameProfile {
            active_fps: f64::NAN,
            idle_fps: f64::INFINITY,
        }
        .clamp();
        assert!(p.active_fps.is_finite() && p.idle_fps.is_finite());
        assert!(p.idle_fps <= p.active_fps);
    }
}
