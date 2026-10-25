//! 日志输出
//!
//! 只有两个宏，刻意不引 `log` crate：M1 阶段日志的唯一目的地就是 stderr，
//! 套一层 facade 还得配 env_logger 与过滤规则，换不来任何东西。
//! 将来真要接 `log`，只需改这十来行 —— 调用点的形状不用动。
//!
//! 统一前缀的意义：这是桌宠，没有控制台 UI，出了问题日志是唯一线索。
//! 前缀散落在各模块里迟早会写歪，而写歪的那条日志在 grep 时等于丢失。
//!
//! 命名上 `warn!` 不能用：它与内置属性 `#[warn(...)]` 撞名，编译器报 E0659。

/// 常规输出
macro_rules! log {
    ($($arg:tt)*) => {
        eprintln!("[heart-star] {}", format_args!($($arg)*))
    };
}

/// 警告。带 `警告：` 标记，便于从大量日志里一眼筛出需要处理的那几条。
macro_rules! log_warn {
    ($($arg:tt)*) => {
        eprintln!("[heart-star] 警告：{}", format_args!($($arg)*))
    };
}

pub(crate) use log;
pub(crate) use log_warn;
