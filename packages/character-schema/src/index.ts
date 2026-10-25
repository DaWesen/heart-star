export * from './semantics.js';
export * from './manifest.js';

// 刻意**不导出** './validate.js'：它 import 了 node:fs，是 Node 专用工具。
// 从包入口导出它，会让任何浏览器端 bundle（renderer / panel）一旦引用本包
// 就把 fs 一起打进去，而浏览器没有 fs —— 表现为构建期 "readFile is not exported
// by __vite-browser-external"，错误信息离真正的诱因很远。
// CLI 通过相对路径 './validate.js' 直接引用，不受影响。
