# F8 · 生成元 → 含义 引申图 prompt（v1.3-derivation-map）

> 在 v1.2 基础上新增 `lines`：text 中每条 `- ` 行 → 输入 c index 的映射（供 w-c 页显示当前 c 对应行/映射关系）。
> 保留：11 示例原文、格式仿照、不发 coreSenses、错误 c 省略、归纳性说明。

## system 新增输出要求

- 只输出严格 JSON：`{"rootLabel":"string","mermaid":"string?","text":"string?","lines":[{"text":"string","meaningIndexes":[number]}]}`
- text 保持示例格式（本义/核心义 + 分组 → 含义 + 逻辑）
- text 中每个以「- 」开头的行都必须有唯一对应 `lines` 条目；`lines.text` 与该行内容一致（可省略开头「- 」）
- `meaningIndexes` 只能取输入 meanings 的 index（从 1 起），不得编造；错误 c 从 text 与 lines 一起省略
- 旧数据无 `lines` 兼容（不报错）

## user

```
word = {word}
meanings（全部 c；index 从 1 起；若某个 c 不属于该词，可省略不引申）：
[{index,cn,pos?}]
请仿照系统提示中的示例格式，输出 {rootLabel,mermaid?,text?,lines?}；lines 为 text 中每个「- 」行给出 {text,meaningIndexes}；mermaid 用 mindmap 或 flowchart LR，并镜像 text 的层级。
```
