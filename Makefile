# Heart Star —— 开发命令
#
# 前置：pnpm、Rust（MSVC 工具链）、WebView2 Runtime、make。
# Windows 下 make 来自 Chocolatey：choco install make
#
# 只需要记住一条：
#     make dev
#
# 它做两件事：
#   1. 起两个前端 dev server（renderer 5173 / panel 5174）
#   2. 由 Tauri CLI 拉起应用（tauri dev）
#
# 为什么不能只用 cargo run：
#   beforeDevCommand 是 Tauri **CLI** 的功能，只有 tauri dev 会执行它。
#   cargo run 直接跑二进制，一个 dev server 都不会起，页面就是空白的。
#
# 为什么是两个 dev server：
#   renderer 与 panel 是两个独立的 vite root，两个窗口各加载一个地址。
#   详见 scripts/dev.mjs。

.DEFAULT_GOAL := dev

.PHONY: dev app servers install build build-app typecheck gen validate fmt lint check kill help

## dev —— 一键启动（推荐）
dev:
	pnpm dev:app

## app —— 只启动应用。dev server 需已跑起来（make servers 或 pnpm dev）
app:
	cd apps/desktop/src-tauri && cargo run

## servers —— 只起两个前端 dev server，不启动应用
servers:
	pnpm dev

install:
	pnpm install

## build —— 只构建两个前端（面板产物落在 renderer/dist/panel 下）
build:
	pnpm build

## build-app —— 打包发布版。会先跑 beforeBuildCommand（= 上面的 build）再打包
build-app:
	cd apps/desktop && tauri build

typecheck:
	pnpm typecheck

## gen —— 由 TS 协议重新生成 Rust 结构。TS 是唯一真源，产物入库
gen:
	pnpm gen:rust

## validate —— 校验角色包结构（默认日和）
validate:
	pnpm validate:characters assets/characters/hiyori

fmt:
	cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
	cargo fmt --manifest-path packages/ai-core/Cargo.toml

## lint —— clippy + TS 类型检查，与 CI 同一套
lint:
	cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
	cargo clippy --manifest-path packages/ai-core/Cargo.toml --all-targets -- -D warnings
	pnpm typecheck

## check —— 提交前跑一遍：生成协议 → 格式化 → lint → 构建 → 校验漂移
check: gen fmt lint build
	git diff --exit-code -- apps/desktop/src-tauri/src/ipc/generated.rs

## kill —— 结束残留的 heart-star 进程。
## 进程没退干净时 cargo 覆盖不了 exe，会报“拒绝访问 (os error 5)”。
kill:
	powershell -NoProfile -Command "Get-Process heart-star -ErrorAction SilentlyContinue | Stop-Process -Force"

help:
	@echo make dev         一键启动：起 dev server 并拉起应用
	@echo make app         只启动应用（dev server 需已在跑）
	@echo make servers     只起两个前端 dev server
	@echo make install     安装依赖
	@echo make build       构建两个前端
	@echo make build-app   打包发布版
	@echo make typecheck   TS 类型检查
	@echo make gen         由 TS 协议重新生成 Rust 结构
	@echo make validate    校验角色包
	@echo make fmt         Rust 格式化
	@echo make lint        clippy + typecheck
	@echo make check       提交前全量检查
	@echo make kill        结束残留的 heart-star 进程
