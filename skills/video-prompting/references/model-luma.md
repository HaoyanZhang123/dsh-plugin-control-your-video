# Luma：34 个运镜 concepts 与两处必踩的坑

> 何时读：已选定 Luma，用户点名要某个运镜（摇、俯仰、推拉、环绕），或写出来的运镜与预期不符时。读它是为了先确认这个键到底存不存在，并知道运镜在这里靠 concepts 表达、没有独立镜头参数。

## 版本与状态

- 来源 URL：https://docs.lumalabs.ai/changelog/concepts （Luma AI，Camera Concepts）
- 页面自述版本：unknown（正文无 updatedAt）；示例里出现 `ray-2` / `ray-1`
- 抓取日期：2026-10-29
- 许可：unknown（D 级或未定），仅作方法研究，不随包
- 是否实测：**否**。34 个键是 `/concepts/list` 的文档返回值，本机未调用、未生成任何片段。

## 一、运镜靠 `concepts`，不靠 camera 参数

`concepts` 是对象数组，可以叠加：

```text
concepts: [ {"key": "pull_out"}, {"key": "tilt_down"} ]
```

**没有独立的 camera 请求参数**。想要运镜只有两条路：给 `concepts` 一个键，或在 prompt 里用自然语言描述。前者是“命名的镜头动作”，后者只能靠文本。

另一个坑：文档里还有 `camera_motion/list`，返回的是带空格的英文短语（如 “camera orbit left”），与 concepts 的 snake_case 是**两套写法**；近似短语可能对不上。写 concepts 就只用 snake_case 键。

## 二、34 个键（按语义分组）

| 组 | 键 |
|---|---|
| 左右摇 | `pan_left`、`pan_right` |
| 俯仰 | `tilt_up`、`tilt_down` |
| 变焦 | `zoom_in`、`zoom_out` |
| 推拉 | `push_in`、`pull_out` |
| 升降 | `pedestal_up`、`pedestal_down` |
| 横移 | `truck_left`、`truck_right` |
| 摇臂 | `crane_up`、`crane_down` |
| 滚转 | `roll_left`、`roll_right` |
| 环绕 | `orbit_left`、`orbit_right` |
| 机位／视角 | `low_angle`、`high_angle`、`overhead`、`ground_level`、`eye_level`、`pov`、`over_the_shoulder`、`selfie` |
| 特殊 | `static`、`handheld`、`bolt_cam`、`dolly_zoom`、`tiny_planet`、`aerial`、`aerial_drone`、`elevator_doors` |

常用叠加（文档给的组合示例）：`pull_out + tilt_down`、`orbit_right + handheld`、`elevator_doors + dolly_zoom`。

## 三、两处真实存在的不存在

1. **没有裸 `pan` / `tilt`**。只有 `pan_left`/`pan_right`、`tilt_up`/`tilt_down`。写 `pan` 或 `tilt` 是无效键。
2. **没有 `dolly_in` / `dolly_out`**。“dolly” 只有 `dolly_zoom`（希区柯克变焦）。想“推近”用 `push_in` 或 `zoom_in`，两者不是一回事：`push_in` 是机位前进（有视差），`zoom_in` 是焦距变化（无视差）。

判断口诀：**要视差就用 push/pull/truck/pedestal/orbit，要压缩空间就用 zoom，要器材带来的不稳就用 handheld。**

## 四、写运镜时的判断

- 键只有名字，**没有强度、时长、缓动**。要“很慢的环绕”只能靠 prompt 补速度描，concepts 本身给不了。
- 一次叠太多键会互相打架（例如同时 `pan_left` 与 `orbit_right`）。一次给 1—2 个，第三个换到 prompt 里当修饰。
- `static` 是显式键，不是“什么都不给”。要完全不动就写 `static`，并检查 prompt 里没有“缓慢移动”这类词。
- 用户描述与键对不上时（“镜头绕着人转半圈然后停”），拆成“orbit + 停留”，别硬塞一个 `tiny_planet`。

## 来源与限制

依据：`resources/research/已确认资产/04-视频模型与提示词/03-Luma-运镜概念/`（说明.md 与原文.md 全文，含 `/concepts/list` 返回的 34 个键）。
未实测：34 个键的实际效果、不同 ray 版本是否逐键支持（文档没有逐键矩阵）、strength／duration 是否真的不接受，均未验证。
缺口：同组 Luma 视频生成与 Modify 文档本次未收，需要比例、时长、首尾帧规则时得回来源目录查；concepts 与 prompt 冲突时谁优先，文档没写。
