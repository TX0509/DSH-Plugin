# 环境安装与自检

先跑自检，按它报的 MISSING 逐项装。**只装本次要用的**，别默认加 `--all`（它连 `--images` 一起查，会把本次用不到的 ego-browser / 图库判成缺失）。

```bash
node "<base>/scripts/mcs.mjs" preflight --page --cards    # 网页 + 卡片
node "<base>/scripts/mcs.mjs" preflight --page --cards --video   # 还要视频
node "<base>/scripts/mcs.mjs" preflight --page --cards --images  # 还要抓截图 / 找图库素材
```

`<base>` 就是加载技能时 `<skill_resources>` 给出的 `Base directory`（插件安装时在插件包的 `assets/multichannel-story/` 下）。

## 0. Windows（DSH Desktop）差异

`scripts/*.sh` 现在只是转发到 `scripts/mcs.mjs` 的薄壳，Windows 上**直接调 mcs.mjs** 即可，
不要依赖 `bash`——DSH Desktop 里的 `bash` 常常是 WSL，路径与 Python 环境都不是同一套。

| 事项 | 统一写法 | macOS / Linux 也可写 |
| --- | --- | --- |
| 自检 | `node <base>/scripts/mcs.mjs preflight --page --cards` | `bash <base>/scripts/preflight.sh --page --cards` |
| 网页 | `node <base>/scripts/mcs.mjs page …` | `bash <base>/scripts/build-page.sh …` |
| 卡片 | `node <base>/scripts/mcs.mjs cards …` | `bash <base>/scripts/build-cards.sh …` |
| 品牌主题 | `node <base>/scripts/mcs.mjs brand …` | `bash <base>/scripts/brand-theme.sh …` |
| 视频工程校验 | `node <base>/scripts/mcs.mjs check <工程目录>` | 同左 |
| 成片核查 | `node <base>/scripts/mcs.mjs verify …` | `bash <base>/scripts/verify-av.sh …` |
| python | `py -3` 或 `python`（自检会自动挑） | `python3` |
| OpenMotion 安装目录 | `%LOCALAPPDATA%\openmotion` | `~/openmotion` |
| edge-tts | `py -3 -m pip install edge-tts` | `python3 -m pip install edge-tts` |
| ffmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |

python 脚本（`tts.py` / `scaffold-video.py`）本身跨平台，Windows 上用 `py -3 <base>/scripts/tts.py …` 调用。
`Pillow` 是可选项（图片裁切/接触表，ffmpeg 也能替代）：缺了自检只提示，不算失败。


## 1. 歸藏设计插件（网页 / 卡片 / 去 AI 味）

提供四个 skill 和 `guizang_library_add` 工具：`guizang-page-skill`、`guizang-social-card-skill`、`humanizer-zh`、`guizang-ppt-skill`。

安装（DSH 插件市场里叫「歸藏设计」，npm 包 `dsh-guizang-design`）：

```
plugin_manager(action="install_bundle", target="dsh-guizang-design")
```

装完确认 skill 文件在（路径随 profile 不同，用 glob 找）：

```bash
ls -d ~/.dsh/profiles/*/node_modules/dsh-guizang-design/skills/guizang-{page,social-card}-skill
```

常见问题：
- 装完技能目录里没有 guizang 系列 skill → 需要重启会话，插件才注册 skill。
- `render.mjs` 报缺 playwright → 插件自带依赖；若确实缺，`cd <插件 skill 目录> && npx playwright install chromium`。
- 卡片渲染报 `browserType.launch: Executable doesn't exist at …chromium_headless_shell-<版本>`：说明本机已有的 playwright 浏览器版本和插件自带的 playwright 版本对不上。在 `dsh-guizang-design` 插件目录里跑 `npx playwright install chromium` 补齐，不要去改 `PLAYWRIGHT_BROWSERS_PATH` 指向的旧版本目录。
- 渲染时提示「字体内置失败，改用在线字体：fetch failed」：字体要从网络取，离线环境下先把字体下载好再渲染，否则截图会掉字。

## 2. OpenMotion（视频）

包含三部分：本机 Studio（后端 + 前端）、DSH 的 MCP 连接、`openmotion` skill。

安装按官方安装文档（仓库 `nexu-io/openmotion` 的 `docs/install.md`），跟随当前宿主的流程；已经装过就不要重装、不要混合 source/npm 两套。

装完的验证只有一条：**在当前会话里真的能调通 MCP**。

```
openmotion_get_project()   # 返回 dataDirectory 和项目列表 = 连接可用
```

连接信息（本机已装好时）：**以 OpenMotion 的 `install.json` 为准，不要记死路径**
- 安装清单：macOS `~/openmotion/install.json`、Windows `%LOCALAPPDATA%\openmotion\install.json`，里面有 `appRoot`（Studio 应用目录）、`dataDirectory`、`launcher`（MCP 启动脚本）。
- `mcs check <工程目录>` 就是靠它找到 `appRoot` 下的 hyperframes CLI；MCP 连接状态仍只能靠对话里的 `openmotion_get_project()`。
- 别照抄网上的固定路径（例如 `~/openmotion/integrations/dsh/...`）：不同安装方式/版本布局会变，`install.json` 才是实际的。

注意：
- **Studio 网址不是 HTTP MCP 端点**，不能用 curl 代替 MCP 调用。
- 工具缺失时先看宿主插件是否启用、MCP 进程是否起来；报具体错误，别绕过。
- MCP 调得通但 Studio 后端没起来时：`open_preview`/`export_request` 会报连接错误，先把 Studio 起起来再重试，不要改工程文件硬绕。

## 3. edge-tts（配音）

```bash
py -3 -m pip install --quiet edge-tts          # Windows
python3 -m pip install --quiet edge-tts        # macOS / Linux
py -3 -c "import edge_tts; print(edge_tts.__version__)"
```

- 需要联网（走微软在线神经语音），零 API Key、零费用。
- 内网/断网环境下可以退到 macOS `say`（见 `voice.md` 的兜底方案），但那是**降级**：先问用户同不同意，同意了也要在交付说明里写明。

## 4. ffmpeg / ffprobe（音频混音、成片核查）

```bash
which ffmpeg ffprobe || brew install ffmpeg
```

## 5. ego-browser（抓真实网页/推文截图）

用户级 skill + CLI 两样都要：

```bash
ls ~/.agents/skills/ego-browser >/dev/null && which ego-browser && ego-browser skill | tail -3
```

没有时按 `~/.agents/skills/ego-browser/references/install.md` 装；`ego-browser` 不在 PATH 时报错就提示用户装 CLI。
注意：X（Twitter）搜索页游客态可用，`/home` 会跳登录；没有登录态时不要假装能搜到，改用公开网页或让用户提供截图。

## 6. 图库与生图（配图）

- `dsh-stock-images`：`stock_image_search` / `stock_image_download`（Pexels / Unsplash / Wikimedia / Openverse 等）。安装：

```
plugin_manager(action="install_bundle", target="dsh-stock-images")
```

- `dsh-image-gen`：`generate_image` / `edit_image`。**非必要不生成**；要用时先确认供应商已配置、费用由用户承担。

## 7. 运行时速查

| 依赖 | 用途 | 检查命令 |
| --- | --- | --- |
| node ≥ 20 | 所有脚本（mcs.mjs / render.mjs） | `node -v` |
| playwright chromium（插件内） | 卡片截图 | `node "<base>/scripts/mcs.mjs" preflight --cards`（会报 chromium 目录） |
| python（≥3.9） | TTS / 视频骨架 | `py -3 -V`（Windows）/ `python3 -V` |
| Pillow（可选） | 图片裁切/接触表 | `py -3 -c "import PIL; print(PIL.__version__)"` |
| ffmpeg/ffprobe | 混音、核查 | `ffmpeg -version` |
| edge-tts | 旁白 | `py -3 -c "import edge_tts"` |
| openmotion | 视频工程/导出/本地校验 | `openmotion_get_project()` 调通；`mcs check <工程目录>` 能跑 |

## 8. 关于 `scripts/install.sh`

那个脚本是**手动安装路线**用的：把 skill 拷到 `~/.agents/skills/multichannel-story`，靠用户级 skill 机制加载。
如果已经装了 `dsh-multichannel-story` 插件，**不要再跑它**——用户目录那份优先级更高（rank 500 < 600），会顶掉插件里的版本，导致插件更新不生效。
