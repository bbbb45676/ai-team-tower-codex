# 小島麵包坊官網（範例專案）

這是 AI 團隊大樓的範例專案：一家虛構麵包店的一頁式官網。大樓的各部門會在這個資料夾裡工作。

- `index.html`、`style.css`：網站本體（故意寫得很陽春，留給部門改進）
- `docs/company-plan.md`：公司計畫書，「目標」面板會從這裡拆出年、季、月目標
- `docs/team/`：PM 與各部門的手冊、例行工作表 `routines.json`
- `.claude/agents/`：PM 與各部門的角色設定（Claude Code 子代理格式）
- `approvals.md`：待核可清單，大樓會把「待擁有者」段的每一列放進「需要你處理」

大樓的工作紀錄會寫在 `.tower/`（不進版本控制）。
