# 07 像素能力

Status: resolved

先读 `../spec.md`，其中的共享接口、并行规则对本工单同样适用。

## 归属

只改这些文件：

- `packages/perception/src/pixel/**`（`types.ts` 不改）
- `packages/perception/src/models/**`：`catalog.ts` 的数据可以按核实结果更正（例如模型的实际输入尺寸），改了在 Comments 里说明
- `packages/perception/test/pixel/**`、`packages/perception/test/models/**`（新建）

`packages/perception/src` 下已有的文件（`ink.ts`、`image.ts`、`opencv.ts` 等）可以导入使用，但不要修改：第二波的工单 05 会改它们。需要它们有变化时写进 Comments。

## 背景

方案 §6.5 的表（抠取、补全、文字剥离、提升分辨率四行）；§6.6 全节：本地与云端的分工、八条约束、外发档位；§6.7 先粗后精。`docs/adr/0003-image-models-dashscope-and-onnx.md`。模型目录 `packages/perception/src/models/catalog.ts`。

`PixelOps` 是给资产构建（工单 06）用的纯像素能力：输入输出都是内存里的图，不知道项目、界面规格和决定。锁定、外发记录、预算的存储由构建通过 `PixelContext` 传进来，本工单只负责在正确的时机调用它们。

每一步都按“由简到难”自动选方法：能用解析方法就不用模型，能用本地模型就不用云端。`quality: 'draft'` 时绝不调用云端。

## 要做的事

### 1. 本地模型：`createModelStore`

- 缓存目录：默认 Windows 上 `%LOCALAPPDATA%\ui-pro\models`，其他系统 `~/.cache/ui-pro/models`；环境变量 `UI_PRO_MODEL_DIR` 可以覆盖（测试用）。
- `path(name)`：文件已在且校验过就直接返回；否则下载。
  - 下载地址依次尝试：环境变量 `HF_ENDPOINT`、`MODEL_ENDPOINTS`，URL 为 `<endpoint>/<repo>/resolve/main/<path>`。
  - 边下边写 `<文件>.part`；通过 `onProgress` 报告进度，每 10% 或每 2 秒一次，用中文。
  - 下完校验大小和 sha256，通过后原子改名。
  - 都失败时报 `E_MODEL_UNAVAILABLE`，提示设置 `HF_ENDPOINT`，或手动下载后放进缓存目录。
- 校验一次 200 MB 的文件要时间：校验结果记在旁边的小文件里（大小、修改时间、哈希），没变就不重算。
- 两个进程同时下载同一个模型不能互相破坏（各用唯一的 `.part` 名，原子改名）。
- ONNX 会话每个进程每个模型只建一次。默认用 CPU；环境变量 `UI_PRO_ORT_EP=dml` 时试用 DirectML，失败就退回 CPU。

### 2. 抠取 `extract`

- `ui`：有 `hint` 时以它为初值修边；没有时在 `box` 内用轮廓或 GrabCut 求前景（先确认 opencv.js 4.9 这个构建里有 `grabCut`，没有就写进 Comments 并用别的办法）。然后在边界带上求柔边透明度，再去除边缘混入的背景色：用透明通道外一圈估计背景色 B，按 F = (I − (1 − α)·B) / α 还原前景色。
- `figure`：用 anime-seg 模型出遮罩，之后同样修边、去色边。
- `text`：位图文字用字形墨迹（含描边和阴影）做透明通道，可以复用 `ink.ts` 的边缘与墨迹方法。
- `style: 'pixel'`：硬边（透明度按 128 二值化），不做平滑。
- `method` 写实际用的方法：`hint`、`contour`、`grabcut`、`anime-seg`、`ink`。

### 3. 补全 `fill`

- **解析**：洞周围一圈是纯色或线性渐变（逐通道拟合平面，残差小）时直接解析填充，`tier: 'analytic'`。
- **本地**：LaMa。输入固定 512×512：在洞周围取一块带上下文的方形区域（洞的外接框放大 2–3 倍），缩放到 512，推理，缩回原尺寸，只在洞内贴回，边界羽化。`tier: 'local'`，`method: 'lama'`。
- **云端**：`quality: 'final'`、有云端图像模型、外发档位不是 `local` 时，按第 7 节的约束调用局部重绘。全部候选都被淘汰时退回本地结果并加一条警告，不报错。
- 无论哪一层，洞外的像素必须与输入完全相同（约束 1）。

### 4. 文字剥离 `stripText`

- 墨迹遮罩：调用方给了就用；没给就在 `box` 内自己算。外扩 2 像素作为补全区域。
- 量出文字样式：字形主体的颜色；描边的颜色和宽度（与主体颜色不同时才有）；阴影的颜色、偏移、模糊；从字形高度换算出的字号。都用请求图的像素。
- 然后按补全的三层填上文字原来的位置。云端用带遮罩的局部重绘，而不是不带遮罩的去文字功能，这样才能满足约束 1。

### 5. 提升分辨率 `upscale`

- **重采样**：倍数不超过 1.25，或像素风（用最近邻），直接用 sharp 缩放，`tier: 'resample'`。
- **本地**：realesr-animevideov3，4 倍。按 256×256 分块推理，块间重叠（例如 16 像素）并羽化拼接，再用 Lanczos 缩到目标倍数。透明通道单独用 Lanczos 放大。`tier: 'local'`。
- **云端**：`quality: 'final'` 时用超分，`upscale_factor` 取不小于倍数的整数（最大 4），再缩到目标尺寸。图小于 512 时先镜像外扩到 512，取回后裁掉外扩。服务只返回 RGB，透明通道沿用本地或重采样的结果。
- `fidelity`：结果缩回输入尺寸后，与输入在不透明像素上算结构相似度。低于阈值（例如 0.9，写成常量）就退回上一层，并加一条警告。

### 6. 云端图像模型：`createCloudImageModel`

- 只有 `provider: 'dashscope'` 且环境里有 `DASHSCOPE_API_KEY` 时才返回模型，否则返回 `null`。密钥只从环境变量读。
- 服务地址：`image_model.endpoint`；没有时用 `https://dashscope.aliyuncs.com`。
- 可以加一个可选参数注入 `fetch`，供测试使用。
- 只做原始的服务调用，不含项目知识；约束在第 7 节那一层实现。
- `capabilities`：`maskInput: true`、`transparentOutput: false`、`layerDecomposition: false`、`minSide: 512`、`maxSide: 4096`、`maxCandidates: 4`。

**接口事实**（2026-11-26 核对自[通义万相图像编辑 API 参考](https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference)）：

- 提交任务：`POST {base}/api/v1/services/aigc/image2image/image-synthesis`。请求头 `Authorization: Bearer <key>`、`Content-Type: application/json`、`X-DashScope-Async: enable`（必须，只支持异步）。
- 请求体：`{ model: 'wanx2.1-imageedit', input: { function, prompt, base_image_url, mask_image_url? }, parameters: { n, seed?, watermark: false, upscale_factor? } }`。
  - `function`：`description_edit_with_mask`（局部重绘，要 `mask_image_url`）、`remove_watermark`（去文字水印）、`super_resolution`（超分，`upscale_factor` 1–4）。
  - `prompt` 必填，不超过 800 字符。`n` 是 1–4。
  - 遮罩：纯白（255,255,255）是要重绘的部分，纯黑（0,0,0）是保留的部分，分辨率必须与原图相同。
  - 图片：公网 URL，或 `data:image/png;base64,...`；JPG、PNG、BMP、TIFF、WEBP；宽和高都在 512–4096 像素之间；不超过 10 MB。
- 响应：`{ output: { task_id, task_status }, request_id }`。
- 查询：`GET {base}/api/v1/tasks/{task_id}`，轮询到 `task_status` 为 `SUCCEEDED`、`FAILED`、`CANCELED` 或 `UNKNOWN`。结果在 `output.results[]`：每项是 `{ url }` 或 `{ code, message }`。结果地址 24 小时内有效，取到后立刻下载。
- 失败时 HTTP 4xx/5xx 带 `code`、`message`。限流时有限次退避重试；轮询要有总超时。
- 华北 2 推荐业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，用户在 `image_model.endpoint` 里配置。

### 7. 云端的八条约束

在 `PixelOps` 的云端这一层实现，对所有云端 Provider 生效：

1. **只取遮罩内的像素**：遮罩内用返回结果，边界处 2–4 像素过渡，遮罩外保留原像素。
2. **对齐校验**：返回图遮罩外的部分（缩回送出时的尺寸）与送出的像素比对；差异超过阈值，或检测到平移、缩放，这个候选作废。
3. **按原始像素密度送图**：按源文件的像素密度裁出目标区域加一圈上下文。不足 512 时先扩大上下文；整张源图都不够 512 时，用 Lanczos 放大到 512 再送，取回后缩回，并在警告里说明。不把整张图重采样后送出。
4. **颜色校正**：遮罩外一圈在结果与原图上的平均颜色（Lab）比对，色差超过阈值的作废。
5. **多候选择优**：一次要 `n` 个候选（默认 2，常量），按边界连续性（洞边界两侧的梯度是否衔接）和纹理一致性（洞内与周围一圈的统计量）打分，选最好的；其余通过 `store.put(output, alternatives)` 保留。
6. **锁定**：调用前先用请求键查 `store.get`，有就直接用、不调用服务；`store.allowNew` 为 false 且没有锁定输出时报 `E_NOT_LOCKED`。本地模型的输出同样走锁定。
7. **预算**：每次调用前 `log.count(screen)` 达到 `budget` 就报 `E_IMAGE_BUDGET`，由构建处理。
8. **外发记录**：每次调用 `log.append`：模型、用途、界面、节点、送出的每张图的 sha256、字节数。

外发档位：`local` 时 `PixelContext.cloud` 为 `null`；`hybrid` 只允许送局部裁片，按第 3 条本来就只送裁片；`cloud` 同样只送裁片，原因是保持像素密度。

## 验收

- 单元测试（合成图，不用模型）：
  - 渐变底上的柔边圆角矩形：抠取的透明度与真值的交并比不低于 0.95，半透明边缘没有背景色残留；
  - 位图文字的墨迹抠取；
  - 渐变上的洞解析填充结果准确；任何一层补全的洞外像素都不变；
  - `stripText` 在合成文字上量出的颜色和字号在容差内；
  - 重采样那一层的放大与 `fidelity`。
- `createModelStore`：用本地 HTTP 服务伪装模型下载站（`HF_ENDPOINT` 指向它，`UI_PRO_MODEL_DIR` 用临时目录，模型换成小文件）。覆盖：下载与进度、哈希不符时报 `E_MODEL_UNAVAILABLE` 且不留文件、第一个地址失败时用第二个、已下载过不再下载。
- 云端：用假的 `fetch` 模拟提交、轮询、取结果。覆盖：
  - 遮罩合成；
  - 平移过的结果被对齐校验淘汰；偏色结果被颜色校正淘汰；
  - 候选择优与落选候选的保留；
  - `E_IMAGE_BUDGET`；外发记录；
  - 已锁定时不调用服务；`allowNew` 为 false 时报 `E_NOT_LOCKED`；
  - 小于 512 的裁片被扩大后再送。
- 本地模型的集成测试（`*.integration.test.ts`，`UI_PRO_MODELS=1` 时才跑）：
  - 在糖果骑士的裁片上用真实的 LaMa 补全（例如去掉装备框上的“+5”）；
  - 用真实的 Real-ESRGAN 放大一个图标；
  - 用真实的 anime-seg 抠出角色。

  输出存到 `.scratch/m1-batch3/ref/pixel/`，父 agent 会看图。
- 真实云端测试只在 `UI_PRO_CLOUD=1` 且有密钥时跑：一次局部重绘。
- 在 Comments 里报告：首次下载各模型的耗时、每次推理的耗时（CPU，本机）、`grabCut` 是否可用、`catalog.ts` 里核实后更正了什么。

## Comments

### 交付说明（子 agent，2026-11-26）

**做了什么**：验收清单全部完成，只改了归属内的文件。

- `packages/perception/src/models/`：`store.ts`（`createModelStore`：HF_ENDPOINT / 内置镜像依次尝试、唯一 `.part`、10% 或 2 秒一条中文进度、大小 + sha256 校验、原子改名、`<文件>.verified.json` 记录校验结果、同进程并发下载合并、超过 24 小时的残留 `.part` 清理、无数据 30 秒放弃、失败抛 `E_MODEL_UNAVAILABLE` 并给 `HF_ENDPOINT` / 手动下载提示）、`session.ts`（每进程每模型只建一次 ONNX 会话；`UI_PRO_ORT_EP=dml` 试 DirectML，失败退回 CPU）。
- `packages/perception/src/pixel/`：`extract`（hint / contour / grabcut / anime-seg / ink，柔边 + 去色边，像素风硬边）、`fill`（解析 → LaMa → 云端）、`stripText`（墨迹外扩 2px、量样式、按补全三层填）、`upscale`（重采样 → 本地 realesr 分块 → 云端；SSIM 低于 0.9 退回）、`dashscope.ts`（`createCloudImageModel` 的 DashScope 实现，异步任务、限流退避、轮询总超时）、`cloud-fill.ts`（八条约束）、`lock.ts`、`compose.ts`、`text-style.ts` 及若干像素工具。`types.ts` 没动。
- 测试：`test/pixel/`（extract、fill、strip-text、upscale、cloud-fill、dashscope、primitives、`models.integration.test.ts`）、`test/models/store.test.ts`。`pnpm vitest run packages/perception/test/pixel packages/perception/test/models`：124 通过、5 跳过（4 个本地模型集成测试 + 1 个真实云端测试，各自要 `UI_PRO_MODELS=1` / `UI_PRO_CLOUD=1`）。`UI_PRO_MODELS=1` 跑了集成测试，4 个全过。`pnpm -s typecheck` 通过；自己的路径 biome 无告警。

**没做 / 没验证**

- 真实云端调用：本机没有 `DASHSCOPE_API_KEY`，只用假 `fetch` 测试，协议按本工单的“接口事实”实现，**没有对真实服务验证过**。真实云端测试（`UI_PRO_CLOUD=1`）已写好但本机没跑。
- `UI_PRO_ORT_EP=dml` 的代码路径没在本机验证过（只验证了 CPU）。

**实测数据（本机，CPU，onnxruntime-node 1.31.1）**

| 模型 | 首次下载 | 会话创建（每进程一次） | 每次推理 |
| --- | --- | --- | --- |
| realesr-animevideov3（2.5 MB） | 2.1 秒 | 0.07 秒 | 每块 256×256 约 0.3–0.4 秒；200×290 图 2 块共约 0.8–1.1 秒 |
| anime-seg（176 MB） | 48.7 秒 | 0.36 秒 | 1024×1024 约 1.0–1.1 秒 |
| LaMa（208 MB） | 56.2 秒 | **15–24 秒** | 512×512 约 2.0–3.0 秒 |

- 端到端：去掉装备框上的“+5”，进程里第一次 ≈ 21.7 秒（其中约 20 秒是 LaMa 建会话），之后同进程每次 ≈ 2.1–2.3 秒。
- LaMa 会话创建慢，换图优化级别救不了（同一台机器、各跑一次：`extended` 16 秒、`all` 19 秒、`basic` 20 秒，`disabled` 反而 30 秒；默认用 `all`）。没有试预先优化再落盘的模型文件。这是**每个 `ui-pro build` 进程**要付一次的成本，只有用到 LaMa（解析填充满足不了）时才付。
- `grabCut` **可用**：opencv.js 4.9 里有 `cv.grabCut`（80×80 约 14 ms）。所以 `ui` 的 GrabCut 回退已实现并有测试（低对比度的合成图走到 `grabcut`，IoU 0.97）。

**`catalog.ts` 更正了什么**（只改了 `io` 说明，`bytes` / `sha256` 经下载校验确认无误）：

- LaMa：输出张量 `output` 是 **0–255，不是 0–1**（原来的说明没写范围，按 0–1 处理会得到一片白）；补了张量名 `image` / `mask` / `output`，批维是动态的（`batch`）。`onnx-runner.ts` 按实际范围自动判断。
- realesr：张量名 `input` / `output`，输出范围约 [−0.03, 1.03]，要裁剪。
- anime-seg：输入名 `img`（固定 1×3×1024×1024，RGB [0,1]，方形，代码里按等比缩放居中加黑边），输出名 `mask`（1×1×1024×1024，[0,1]）。原来写的是“见 README”。

**产出的图**（`.scratch/m1-batch3/ref/pixel/`，父 agent 可以看）：`lama-strip-plus5.png`（左原图右结果：“+5”去掉了，橘色徽章还在）、`lama-fill-edge.png`、`esrgan-icon.png`（左 Lanczos 右模型）、`esrgan-piece-after.png` / `esrgan-piece-lanczos.png`（两块拼接，没有接缝）、`animeseg-figure-over-magenta.png`（原图 | 抠出的角色衬在品红上）、`animeseg-figure.png`、`timings.json`、`lama-strip-plus5-measured.json`。

**与工单的偏差和我做的决定（请父 agent 看一下）**

1. **云端候选全被淘汰时，本地结果锁在“云端请求的键”下**（`by: 'local:lama'`，返回里带中文警告，不报错）。这样重新构建既不再调云端，`--locked` 也能复现。**服务本身失败**（HTTP 错误、任务 `FAILED`、全部结果都是 `{code,message}`）则抛 `E_CLOUD_IMAGE`，不静默退回——两种情况是我区分的，工单只写了前一种；06 要不要把后一种降级成本地，由构建决定。
2. 外发记录在调用服务**之前**写（保守：失败的调用也留痕）；预算检查在查锁定**之后**、调用**之前**，所以已锁定的输出不受预算限制。
3. 过渡带怎么算：洞内边缘 2–4 像素（本地 2、云端 3）从**洞外最近像素的颜色**渐变到生成的像素，不是从洞里原来的内容渐变（那是要去掉的东西，会留鬼影）。洞外字节与输入完全相同，每一层都有测试。像素风不羽化。
4. 锁定内容：锁定的 PNG 是请求大小的整张结果图（RGBA）；复用时只在洞内贴回，所以洞外仍与输入一致。落选候选也是整张合成图。请求键 = sha256（操作、模型、参数、输入尺寸 + 原始像素）；本地模型的标识是 `local:<名>@<sha 前 12 位>`。
5. `stripText` 的云端走“带遮罩的局部重绘”（外发记录的 `purpose` 是 `remove-text`），没用不带遮罩的去文字接口；`CloudImageModel.removeText` 在 DashScope 里仍按原始接口实现了。
6. 给测试加了可选参数，不影响 06 的调用：`createPixelOps(context, { runner? })`、`createModelStore` 多了 `env` / `catalog` / `fetch` / `stallMs`、`createCloudImageModel(config, env, { fetch, pollMs, timeoutMs, retries, sleep })`。06 现在传的 `{ onProgress, env }` 照常工作。
7. 本地超分只处理不超过 200 万像素的图，更大的退回重采样并警告（常量 `MAX_LOCAL_PIXELS`）。
8. 最终回退也会锁：本地超分的 SSIM 低于 0.9 时退回重采样，这个结果同样锁定（`by: 'local:resample'`），保证 `--locked` 重建得到同一张图。

**已知局限**

- 字号由字形高度除以 0.72（大写字母和数字的字高占比）换算，方块字（CJK）字形更满，估出来偏小；描边只认宽度 ≤ 6 的外圈；阴影偏移只认 ±6 内；阴影模糊是边缘过渡宽度的粗估，不到 1.2 像素不报。2 像素宽的描边会混入抗锯齿，量出的颜色偏淡，3 像素以上准确。
- 文字在徽章/按钮上、徽章只比文字大几个像素时（例如“+5”），背景色改取文本框内侧一圈，并只保留文本框外 1 像素内的墨迹，否则整个徽章会被当成文字（集成测试里第一版就是这样把徽章整个抹掉的）。框与真实文字相差超过 3 像素时这个策略会失准。
- LaMa 的上下文是洞外接框的 2.5 倍（至少各边多 16 像素），洞很大或形状极端时质量会下降；这只是初稿，终稿靠云端。

### 审核（父 agent）

通过。

- 看了 `ref/pixel/` 的图：LaMa 去掉“+5”后徽章底保留、边缘无残影；anime-seg 抠出的角色衬在品红上没有背景色残留；Real-ESRGAN 明显比 Lanczos 清晰。
- 复跑 `UI_PRO_MODELS=1 pnpm vitest run packages/perception/test/pixel packages/perception/test/models`：128 通过、1 跳过（真实云端）。全仓 `pnpm -s typecheck` 通过，归属内 biome 无告警。
- 密钥只从 `DASHSCOPE_API_KEY` 读；错误详情只带状态码、任务号、请求号；取结果图时不带 `Authorization`，密钥不会发到对象存储的域名。
- 云端只在 `quality: 'final'`、有云端模型、外发档位不是 `local` 时调用（`fill`、`upscale` 两处）；顺序是查锁定 → `allowNew` → 预算 → 外发记录 → 调用，与约束一致。
- 偏差 1–8 都接受。其中第 1 条留给 06：服务本身失败抛 `E_CLOUD_IMAGE`，构建决定是否退回本地并记近似项。

留到后面的事：

- 字号按 0.72 的字高占比换算，中文字形更满，量出来会偏小。糖果骑士全是中文，06 若用 `stripText` 量出的字号写 `text.size`，端到端联调时要核对。
- LaMa 每个构建进程首次建会话 15–24 秒，M1 可以接受；以后可以试预先优化后落盘的模型文件。
