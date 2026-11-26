# 小红书图文 + 公众号封面（guizang-social-card-skill）

## 产物

- 小红书 3:4，`1080×1440`，6–9 张（1 封面 + 内容页），PNG。
- 公众号封面一对：21:9 主封面 `2100×900` + 1:1 分享卡 `1080×1080`，同文件内各自构图，**不要**把 21:9 直接裁成 1:1。
- 命名：`xhs-01-cover.png`、`xhs-02-…`、`wechat-21x9.png`、`wechat-1x1.png`。

## 流程

1. 拷贝 seed 模板（**不要从空白 HTML 手写**）。模板在「歸藏设计」插件的 `dsh-guizang-design/skills/guizang-social-card-skill/assets/` 下（`mcs cards` 会自动找，找不到 index.html 时直接拷一份）：
   - 杂志风 → `guizang-social-card-skill/assets/template-editorial-card.html`
   - 瑞士风 → `guizang-social-card-skill/assets/template-swiss-card.html`
2. 主题与网页保持一致：`<html data-theme="indigo-porcelain">`（或网页实际用的主题）。
   有品牌色时不要手写颜色值：`mcs brand "#76B900" --apply index.html`（注入 `[data-theme="brand"]` 并切到 brand 主题）。
3. 替换 `<!-- POSTERS_HERE -->` 区域，每页一个 `.poster` + 一条版式 recipe（M01–M16 / S01–S12）。
4. 渲染：

```bash
node "<base>/scripts/mcs.mjs" cards <任务目录>
```

5. 逐张看 PNG 自检，再跑到 `validate-social-deck` 0 fail（`mcs cards` 默认渲染后自动校验；脚本在 `guizang-social-card-skill/validate-social-deck.mjs`）。

## 硬性约束

- **3:4 必须吃满画布**：内容覆盖 ≥75% 高度；不要用 `flex:1` 上下夹空中段；大片留白要有理由（单句宣言/大图呼吸）。
- 标题不贴边、不撞页脚；`.foot`/`issue-strip` 用 `margin-top:auto` 定位。
- 中文不斜体；杂志风「越大越轻」；正文最小 24px、标注最小 28px。
- 一页一件事；单行中文 ≤ 8 字，砍字不缩字。
- **画面上不写比例与像素尺寸**：不要 `21:9`、`2100×900`、`1:1`、`1080×1080` 这类制作标注（用户明确要求）。页码 `01/07`、栏目名可以留。
- **不要产出带尺寸标签的配对预览图**（那是 QA 图，不是交付物）。
- 不要无意义装饰：贴纸、圆点、伪科技线、假时间轴。
- 没有免费图源时，封面优先用「真实素材 + 大字排版」，不要为了填画面去生成 AI 图。

## 素材

- 复用网页那批图（`assets/figs/`），横幅/竖幅分别指定 `object-position`，不要让人脸被裁。
- 带截图的页面（推文、行情）用 `.frame-shot` 类，保留 UI 可读性；不要拉伸。
- 素材许可写在 `assets/SOURCES.md`。

## 常见返工点

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 校验报 `content_overlap` | 标题 `h2` 没设 `position:absolute` 或被默认 margin 顶开 | 加 `margin:0; position:absolute; left/right` |
| 页面下方 200px 空白 | 内容不足 | 加一条账单/引文/注解，或合并页 |
| 文字被切 | 绝对定位 + 未留安全边 | 顶部/左右至少 72px，底部留 150px 给 issue-strip |
| 字号被校验打回 | body < 24px、meta < 28px | 改文案而不是缩字号 |
