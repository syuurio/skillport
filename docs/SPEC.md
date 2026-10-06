# skillport 設計規格

> 狀態：草稿，待確認 · 2026-10-05
> 工具名稱 `skillport`，指令範例以 alias `skl` 簡寫。

## 1. 問題

有些 skill 包不走 marketplace，而是用作者自己的 installer 發布（Emil 的 `@aiforui/install`、`@animationsdev/install`，Motion 的 `motion-ai`）。這些 installer 把同一份 skill 複製進每個偵測到的 agent 目錄（`~/.claude/skills`、`~/.codex/skills`、`~/.cursor/skills`…），沒有 lock、沒有更新指令。結果：

- 同一個 skill 散落成 5 份實體副本，改一份不會同步其他份。
- 不知道哪個 skill 從哪來、什麼時候裝的、有沒有新版。
- 更新只能重跑 installer，再手動清理舊副本。

## 2. 目標

一個地方註冊「我要追蹤的 skill 集」，用同一組指令查看、檢查更新、更新、移除，不論 skill 集透過 vendor installer 還是 `npx skills add` 安裝。

### 非目標

- **預設不改名、不加 namespace、不改寫 skill 內容。** 只有撞名且你選擇改名時，才改那一個 skill（§8）。
- 不取代 `npx skills` 或 Claude Code plugin marketplace；能委派就委派。
- 不管理 MCP 設定、Claude agent 定義等 installer 的附帶產物。
- 不做跨機器同步。

## 3. 名詞

| 名詞 | 意思 |
|---|---|
| **skill 集（set）** | 一個註冊單位，對應一個來源，例如 `aiforui`、`matt`。一個 set 產出一到多個 skill |
| **負責者（owner）** | 實際寫入某個 skill 目錄、並記錄它的工具。每個 skill 目錄只有一個負責者：`npx skills` 或 skillport |
| **暫存區（staging）** | skillport 執行 installer、比對差異用的目錄，不在任何 agent 會掃描的路徑下 |
| **trash** | 被取代或移除的 skill 目錄移到這裡，skillport 從不 `rm` |

## 4. 架構

```
             ~/.config/skillport/registry.json  （你註冊的 skill 集）
                              │
            ┌─────────────────┴─────────────────┐
     type: skills-cli                    type: installer | npm
     (委派給 npx skills)                  (skillport 自己負責)
            │                                   │
   npx skills add <repo> -g              假 $HOME → 暫存區 → 比對
     -a codex -a claude-code -s … -y            │
            │                                   │
   ~/.agents/.skill-lock.json            ~/.agents/.skillport/state.json
            └─────────────────┬─────────────────┘
                     ~/.agents/skills/   ← 唯一的實體位置
                     ~/.claude/skills/   ← 只放 symlink
```

### 為什麼只有一個實體位置就夠

| Agent | 讀 `~/.agents/skills` | 依據 |
|---|---|---|
| Codex | 是 | 官方文件 |
| Cursor | 是 | 官方文件 |
| OpenCode | 是 | 官方文件 |
| Claude Code | **否**，需要 symlink 到 `~/.claude/skills` | 官方文件；文件確認支援 symlink 目錄 |
| Grok | 是，也讀 `~/.claude/skills` | 已驗證（grok 1.0.46）：兩個目錄的 skill 都看得到；同一個 skill 經 symlink 出現在兩處時只算一份。不需要連結 |

### 負責者規則

- `skills-cli` set：`npx skills` 寫入目錄、symlink、lock。skillport 只呼叫它、讀它的 lock。
- `installer` / `npm` set：skillport 寫入目錄、symlink、state。
- skillport 讀兩份記錄，合併成一個視圖（status、check、撞名偵測）。
- 任何人寫入 `~/.agents/skills` 下一個不屬於自己的目錄 → skillport 拒絕執行（§8）。

## 5. Skill 集類型

### 5.1 `skills-cli`

委派給 `npx skills`（固定 `skills@1.7.0`）。它負責目錄、symlink 與 `~/.agents/.skill-lock.json`；skillport 決定要它做什麼，並在呼叫前檢查撞名。`source` 是你會傳給 `npx skills add` 的任何寫法（GitHub `owner/repo`、URL、它認得的名稱）。

| 動作 | 執行 |
|---|---|
| 列出可裝的 skill | `npx skills add <source> --list`，解析文字輸出（`--list` 不接受 `--json`，已驗證） |
| 安裝 | `npx skills add <source> -g -a codex [-a claude-code] -s <name>… -y` |
| 更新 | `npx skills update <name>… -g -y`，只送上游有變的 |
| 移除 | `npx skills remove <name>… -g -y` |
| 檢查 | lock 的 `skillFolderHash`（git tree hash）對 GitHub `git/trees/HEAD:<dir>`；非 GitHub 來源標為「can't tell」並交給 `update` |

- **`-a` 要重複寫**：`-a codex -a claude-code`。逗號寫法 `-a codex,claude-code` 會被拒絕（`Invalid agents`，已驗證）。M0 當時記錄的逗號寫法是錯的：那次測試的參數被 zsh 當成一個字串傳入，結果不成立；同一次測得的「只給 `-a codex` 也會建 Claude symlink」也一併作廢。
- `-a codex` 讓實體放在 `~/.agents/skills`；`links` 含 Claude Code 時加 `-a claude-code`，得到相對 symlink（已驗證）。只給 `-a claude-code` 會把實體寫進 `~/.claude/skills`。
- **`npx skills add` 會直接覆蓋同名目錄，不警告**（已驗證：在沙盒 `~/.agents/skills/tdd` 放自己的 `SKILL.md`，安裝後被換掉）。所以呼叫前先檢查：撞到 skillport 管理的 skill、其他 `npx skills` 來源、`~/.agents/skills` 下的無主目錄、或 `~/.claude/skills` 下的非 symlink，就中止。
- **每個 set 只動自己裝的 skill**：lock 只記「從哪個來源來」，不記「是哪個 set 要的」，所以 skillport 在 state 的 `cli` 欄位記下每個 skills-cli set 叫 `npx skills` 裝過哪些 skill。`update` 與 `remove` 只會移除記錄裡、而且這個 set 不再要的 skill；同一來源中不在記錄裡的 skill（你手動裝的、別處裝的）列為「left alone」，不更新、不記錄、不移除，**即使這個 set 也想要同名的 skill**（`npx skills remove` 是真的刪除，不進 trash；收為己有會讓之後的 remove 刪掉它）。要讓 set 接手一個手動裝的 skill：先 `npx skills remove <name> -g`，再 `skl update <set>`。同一個來源只能有一個 skills-cli set（registry 讀取時檢查）。
- skills-cli 的名稱屬於 `npx skills`，skillport 不改名；撞名時只能在這一邊 `exclude`，或去改另一邊（skillport 管理的 set）的名稱，或用這邊覆蓋另一邊。
- 執行時用真實 `HOME`（它要寫進 `~/.agents`），但環境變數一樣是最小集合（§9）。
- skills-cli set 的擁有記錄在 `npx skills` 每一步（remove、add、update）成功後就寫入；`add` 中途失敗時，lock 裡已經出現的那些名稱也記下。所以任何一步失敗，已經裝上的 skill 仍算這個 set 的。
- GitHub 來源比對時不分大小寫（`Owner/Repo` 與 `owner/repo` 是同一個來源）。
- wizard 選 skills-cli 時至少要勾一個 skill；registry 省略 `skills` 才是「全部」。
- `links` 對 skills-cli set 也成立：npx skills 只在 add 時建 link，所以 skillport 每次 update 會替已安裝的 skill 補上或移除 Claude Code 的 link，讓它符合設定；不是 skillport 或 npx skills 建的東西不動。`status` 只算這個 set 記錄擁有的 skill，並列出同一來源中「留著不動」的。

### 5.2 `installer`

執行 vendor installer，用假 `$HOME` 讓它只寫進暫存區。

```
假 $HOME = <staging>/home，其中只建立 .claude/（stage）
執行：HOME=<staging>/home  <command> <unattended…>
取出：<staging>/home/.claude/skills/*（harvest）
```

- installer 用 `os.homedir()` 決定寫入位置與偵測 agent；Node 在 POSIX 上從 `$HOME` 取值（已驗證）。
- 只放 `.claude` 讓它只偵測到 Claude Code，產出就是 vendor 的原始檔案，不會多出 Codex 的 `agents/openai.yaml`（選用的 metadata，已驗證）。
- `npm_config_cache` 指回真實的 `~/.npm`，避免每次重新下載。
- 換寫入目標只需改設定（`stage`、`harvest`），不改程式。
- **skillport 不替 installer 加任何旗標。** 範圍旗標（Emil 的 `--global`）寫在 `command` 裡；非互動旗標寫在 `unattended`（Emil 的 `["-y"]`）。沒有 `unattended` 的 set 只能互動執行，`update`、`check` 會略過並提示 `-i`。

### 5.3 `npm`

給不能非互動執行的 installer（`motion-ai` 在非 TTY 下直接拒絕執行）。`npm pack <package>@<ver>`，解開後從指定路徑取出 skill。不執行套件內的任何程式碼。

### 5.4 有互動問題的 installer

依序嘗試，用第一個可行的：

| 順序 | 做法 | 適用 | 例子 |
|---|---|---|---|
| 1 | **非互動旗標**：registry 的 `unattended`（例如 `-y`），加上不給 TTY | installer 有非互動模式 | Emil 的兩個 installer：非 TTY 或 `-y` 時 4 個問題全部跳過，用預設值（global、全部偵測到的 agent、全部 skill、不改名） |
| 2 | **`npm` 類型**：不執行，直接取出套件內容 | skill 內容打包在套件裡 | `motion-ai` |
| 3 | **互動執行**（`-i`）：你在 skillport 準備好的沙盒裡親自回答問題 | 只能互動執行、內容又是執行時才下載 | registry 沒有 `unattended` 的 set |

不採用的做法：用 pseudo-terminal 自動回答（expect 式）。問題文字或順序一改就會答錯，而且答錯時不一定會失敗，可能靜靜裝錯東西。

#### 互動安裝，之後用記錄重播更新

`skl add` 對 installer 類型**預設互動**（決定紀錄 #6）；`skl add <set> -y` 改為非互動、安裝全部。`skl update` 預設非互動，`skl update <set> -i` 重新互動。

- installer 拿到真正的 TTY，但仍在沙盒裡執行。範圍旗標（例如 `--global`）寫在 registry 的 `command` 裡，skillport 自己不加旗標（§5.2）；沙盒裡只有 `.claude`，所以「裝在哪裡」和「裝到哪些 agent」兩題不會出現（位置由 skillport 決定）；**「裝哪些 skill」和「要不要改名」照常由你回答**（依 `@aiforui/install@0.1.4` 原始碼第 320、350、395、413 行）。
- installer 結束後，skillport 把你的回答轉成 registry 記錄：
  - 勾選的 skill → `skills` 允許清單。
  - 在 installer 裡改的名稱（目錄名 ≠ frontmatter `name`）→ `rename`，`reason` 記為 `"renamed in installer"`，並補改 frontmatter 與引用（§8.3）。installer 的改名功能只改目錄名、不改 `name`，不補改的話 Codex 會用舊名稱識別它。
- 之後的 `skl update`（不加 `-i`）用非互動模式執行，並套用記錄下來的 `skills` 與 `rename`，結果和你上次互動選擇的一樣。
- 上游新增的 skill 不在允許清單裡，所以不會自動安裝；`check` 會列為「新增，未選」。想加入就跑一次 `-i`，或把名稱加進 `skills`。

#### 防止卡住

自動執行時，installer 的 stdin 一律接 `/dev/null`，並設逾時（5 分鐘）。installer 如果還是跳出問題，會讀到 EOF 而結束，不會無限等待。逾時、輸出最後幾行像是問題（`(y/n)`、`?` 結尾、`Ok to proceed` 等），或輸出 `cancelled` 卻沒裝任何東西時，skillport 回報「installer 正在等你回答，請用 `skl update <set> -i`」，**不算失敗**（結束碼 0），也不中斷其他 set 的更新。

#### 只能互動的 installer

不另設 `capture` 指令（原規劃），改用既有的 `-i`：registry 沒有 `unattended` 的 set 就是「只能互動」，`update` 與 `check` 會略過並提示 `skl update <set> -i`。`-i` 的行為就是原規劃的 capture：installer 拿到真正的 TTY，檔案仍只寫進沙盒，結束後照常比對、檢查撞名、確認、套用，並把你的選擇記進 registry。

已知限制：installer 如果寫入 `$HOME` 以外的位置（例如 `/usr/local`），沙盒攔不到。執行時的 cwd 設在沙盒內，可以攔住 project 模式的寫入。

## 6. 資料格式

### 6.1 Registry（使用者編輯）

位置：`~/.config/skillport/registry.json`（可用 `SKILLPORT_REGISTRY` 覆寫）。

```json
{
  "version": 1,
  "sets": {
    "matt": {
      "type": "skills-cli",
      "source": "mattpocock/skills",
      "skills": ["tdd", "code-review", "grilling", "diagnosing-bugs"]
    },
    "aiforui": {
      "type": "installer",
      "command": ["npx", "-y", "@aiforui/install@0.1.4", "--token={secret}", "--global"],
      "unattended": ["-y"],
      "secret": "keychain"
    },
    "animationsdev": {
      "type": "installer",
      "command": ["npx", "-y", "@animationsdev/install@0.2.3", "--token={secret}",
                  "--api=https://animations.dev", "--global"],
      "unattended": ["-y"],
      "secret": "keychain",
      "prefix": "anim",
      "rename": {
        "prototype": { "to": "anim-prototype", "reason": "collides with matt/prototype", "at": "2026-10-05" }
      }
    },
    "motion": {
      "type": "npm",
      "package": "motion-ai@14.1.0",
      "path": "content/skills"
    }
  }
}
```

| 欄位 | 適用類型 | 說明 |
|---|---|---|
| `skills` | 全部 | 要裝哪些 skill；省略 = 全部。installer 互動安裝後由你的勾選寫入 |
| `exclude` | 全部 | 不安裝的 skill（用 vendor 原名） |
| `prefix` | installer、npm | 撞名時「加前綴」選項的預設前綴；省略 = set 名稱 |
| `links` | 全部 | 要建 symlink 的 agent（`LINK_TARGETS` 的 id，目前只有 `claude-code`）；省略 = `["claude-code"]`；`[]` = 不連結。改掉某個目標時，skillport 只移除自己建的那條 symlink |
| `rename` | installer、npm | vendor 原名 → 安裝名稱，附原因與日期；由撞名處理寫入，也可手動編輯 |
| `command` | installer | 完整 argv，含範圍旗標；`{secret}` 執行時替換。skillport 不另加旗標 |
| `unattended` | installer | 非互動執行時附加的旗標，例如 `["-y"]`；不需要就寫 `[]`；省略 = 只能互動執行 |
| `stage` / `harvest` | installer | 預設 `[".claude"]` / `".claude/skills"` |
| `secret` | installer | `"keychain"`：從 Keychain（service `skillport`、account = set 名稱）讀取 |
| `package` / `path` | npm | 固定到 `name@x.y.z` 的 registry 套件（git URL、`owner/repo`、網址、本機路徑一律拒絕）、套件內 skill 目錄（相對路徑，不得有 `..`） |
| `stage` / `harvest` | installer | 沙盒 HOME 裡的相對路徑，不得有 `..` |

registry 每次讀取都完整驗證（不只 wizard 寫入時），有問題就停止並列出。

版本一律固定在 `command` / `package` 裡。升級 installer 是你的決定（§7.3 只提示）。

### 6.2 State（skillport 寫入）

位置：`~/.agents/.skillport/state.json`。只記錄 skillport 負責的 set；`skills-cli` set 的狀態讀 `~/.agents/.skill-lock.json`。

```json
{
  "version": 1,
  "sets": {
    "aiforui": {
      "source": "@aiforui/install@0.1.4",
      "syncedAt": "2026-10-05T08:30:00Z",
      "skills": {
        "emil-color": { "hash": "9f2c…", "installed": "9f2c…", "updatedAt": "2026-10-05T08:30:00Z" }
      }
    },
    "animationsdev": {
      "skills": {
        "anim-prototype": { "original": "prototype", "hash": "c41d…", "installed": "7a03…", "updatedAt": "2026-10-05T08:30:00Z" }
      }
    }
  },
  "cli": {
    "matt": { "syncedAt": "2026-10-06T10:00:00Z", "skills": ["tdd", "code-review"] }
  }
}
```

`hash` 用 **git tree hash**，和 `npx skills` 的 `skillFolderHash` 同一種演算法（已驗證：本機 16 個 skill 中 13 個與 lock 記錄一致，另 3 個是本機內容已偏離安裝時的版本）。同一種 hash 讓 skillport 能用 GitHub 的資料夾 hash 判斷 skills-cli 的上游有沒有變；但 `npx skills` 複製時會丟掉部分檔案、非 GitHub 來源記的是 sha256，所以不能拿它和磁碟比對偏離（§7.8）。

`cli` 記錄每個 skills-cli set 實際擁有的 skill（§5.1）。

`installed` 是 skillport 實際寫入的內容（改名、改寫引用之後）的 tree hash；磁碟上的內容和它不同，就是有人手動改過（`status` 與 `doctor` 回報「edited」）。

改過名的 skill，`hash` 算的是 **vendor 原始內容**（改名、改寫引用之前），所以下次 check 時，改名本身不會被當成「有改動」或「偏離」。

### 6.3 目錄配置

```
~/.agents/
  skills/                  實體 skill（兩種負責者共用）
  .skill-lock.json         npx skills 的 lock（只讀）
  .skillport/              0700：staging 裡有 installer 的假 HOME，可能留下 token
    state.json
    lock.d/pid             同一時間只跑一個 skillport；pid 已不存在的 lock 會被接手；沒有 pid 檔且超過 10 秒的 lock（擁有者在寫 pid 前就結束）也算過期；接手時會確認搬走的正是判定過期的那個資料夾（以修改時間辨識），搬到新建的就放回去重試
    staging/<set>/         比對用，每次結束（含錯誤、Ctrl-C、SIGHUP、SIGTERM）都清空
    trash/<時間>-<set>/    被取代、移除的舊版本
```

開發與測試時可用 `SKILLPORT_HOME` 把以上所有路徑（含 registry、`~/.claude/skills`）搬到別處；Keychain 與 npm 快取仍用真實 HOME。

staging 和 trash 不放在 `skills/` 底下：Cursor 會遞迴掃描 skill 根目錄，留在裡面的 `SKILL.md` 都會被載入（官方文件）。

## 7. 指令

所有會改動檔案的指令都先印出計畫，確認後才執行；`-y` 跳過確認，`--dry-run` 只印計畫。

### 7.1 `skl status`

列出所有 set 與 skill，資料來自 state 與 lock，不連網。

```
aiforui        installer   28 skills   10/05 更新
animationsdev  installer   15 skills   10/05 更新   排除: prototype
motion         npm          1 skill    10/05 更新
matt           skills-cli   4 skills   10/05 更新

⚠ 2 個問題，執行 skl doctor 查看
```

### 7.2 `skl check [set...]`

只讀，檢查有沒有新版，不改動任何檔案。

| 類型 | 做法 | 成本 |
|---|---|---|
| installer | 執行到暫存區，逐一比對 tree hash | 每個 set 一次完整下載 |
| npm | `npm view` 比對版本（查不到時照樣規劃目前版本並說明）。有新版：下載新版，照「把版本號改成新版」規劃一次，列出會變的 skill 與撞名。已是最新：仍下載目前版本並規劃一次，回報撞名與手動修改（套件內容固定，但其他 set 與資料夾可能變了） | 一次 registry 查詢加一次下載 |
| skills-cli | 上游該 skill 目錄的 tree hash（GitHub `git/trees/HEAD:<dir>`）對 `skillFolderHash`；先用 `gh`，沒有登入時改用公開 API（curl，每小時 60 次） | 每個已安裝 skill 一次 API 查詢 |

```
aiforui        有改動 emil-color, emil-typography · 新增 emil-charts
animationsdev  沒有改動
motion         沒有改動 · installer 有新版 motion-ai@14.2.0（目前固定 14.1.0）
matt           有改動 tdd, code-review · 上游新增 implement-spec, pr（未選）
               tdd: https://github.com/mattpocock/skills/commits/HEAD/skills/engineering/tdd
```

skills-cli 有改動的 skill 附上該資料夾在 GitHub 的 commit 歷史連結（lock 只記 tree hash、不記 commit，做不出 compare 連結）。非 GitHub 來源或 GitHub 沒回應時標為「can't tell」，`update` 會直接重抓它們。

### 7.3 `skl update [set...]`

執行 check，列出計畫，確認後套用：

- installer / npm：有改動的 skill 整個目錄替換（舊目錄移到 trash，新目錄 rename 進來），不做逐檔覆寫，所以 vendor 刪掉的檔案不會殘留。
- 你手動改過的 skill：只要 skillport 要寫的內容沒變（上游沒改、改名規則沒變），就保留你的修改，回報「edits kept」；有新內容要寫時才替換並回報「edits replaced」，你的版本留在 trash。被新的改名規則搬走、或上游已不再提供而移除的資料夾，若有你的修改，同樣列在「edits replaced」。
- skills-cli：呼叫 `npx skills update`。
- installer 的新版本只提示，不自動升級；要升級就改 registry 裡的版本號。

### 7.4 `skl diff <set> <skill>`

把暫存區的新版本和已安裝版本做 `diff -ru`，看改了什麼。

### 7.5 `skl add <set> [-y]`

在 registry 新增 set 後執行第一次安裝。需要 secret 時提示存進 Keychain。installer 類型預設互動執行（§5.4），由你勾選 skill、決定改名；`-y` 跳過，安裝全部。

### 7.6 `skl remove <set>`

移除該 set 所有 skill：skillport 負責的移到 trash 並移除 symlink；skills-cli 呼叫 `npx skills remove`。從 registry 刪除該 set。

### 7.7 `skl secret <set>`

把 token 存進 Keychain。終端機下用 `security` 的互動提示；非終端機（`!`、pipe）從 stdin 讀。拒絕空值，寫入後讀回驗證。

### 7.8 `skl doctor [--fix]`

不加 `--fix` 只報告（• 可安全修正、! 需要你判斷）。加 `--fix` 時先列出計畫，和其他會改動檔案的指令一樣：`--dry-run` 只看計畫，終端機上詢問確認，沒有終端機要加 `-y`。

| 問題 | 例子 | `--fix` 的處理 |
|---|---|---|
| 散落的 vendor 副本 | 手動重跑了 Emil installer，`~/.codex/skills/animate` 又出現 | 內容和受管版本相同 → 移到 trash；不同 → 只報告 |
| 斷掉的 symlink | `~/.claude/skills/x` 指向不存在的目錄 | 指向 `~/.agents/skills` 的：移到 trash；指向別處的：只報告（不是 skillport 的） |
| 缺少的 symlink | 受管 skill 在 `~/.claude/skills` 沒有 link | 補建 |
| 撞名 | 兩個負責者想要同一個目錄名 | 只報告 |
| 偏離 | skillport 管理的 skill 和寫入時的 tree hash 不同 | 只報告，並說明下一次更新會怎樣 |
| 無主目錄 | `~/.agents/skills` 下有目錄不屬於任何負責者 | 只報告（用 `skl adopt` 或撞名提示裡的「收進來」） |
| 不合法的名稱 | state 或 lock 裡有 `../x` 這類名稱 | 只報告，且絕不拿來組路徑 |
| 不再需要的改名規則 | 原名已經沒有別的佔用者（其他 set、`npx skills`、`~/.agents/skills` 的資料夾、不是 skillport 建的 link 都算佔用）；或 vendor 已不再提供原本那個 skill。在 installer 裡自己選的改名是偏好，不算 | 只報告（`status` 也會列出），附上 `skl resolve <set> <skill> --undo` |

`npx skills` 的 skill 不做偏離檢查：它複製時會丟掉部分檔案（`metadata.json`、`.git` 等），非 GitHub 來源的 `skillFolderHash` 又是 sha256，和磁碟上的 tree hash 永遠對不上，檢查只會誤報（已讀 skills@1.7.0 原始碼確認）。

每個修正在執行當下都會再確認一次對象仍是報告時的狀態（例如 link 還是同一條、副本仍相同），不是就跳過。

「散落副本」的判定：目錄名稱等於某個受管 skill（skillport 或 `npx skills` 管理），且位於已知 agent 目錄（`~/.claude/skills`、`~/.codex/skills`、`~/.cursor/skills`、`~/.config/opencode/skills`、`~/.gemini/skills`），且不是指向 `~/.agents/skills` 的 symlink。內容和受管版本相同，或只多了 installer 為 Codex 加的 `agents/openai.yaml`（`agents/` 裡只有這一個檔案，且受管版本沒有 `agents/`）時，算「相同」；你自己加的任何檔案都讓它算「不同」，`--fix` 會移到 trash；內容不同只報告。

link 資料夾（`~/.claude/skills`）裡的副本，如果它所屬的 skill 沒有連結到那裡（例如你用 `npx skills --copy` 手動裝的），可能是該 agent 唯一讀得到的那份：只報告，`--fix` 不動。

「無主目錄」只算 `~/.agents/skills` 下的真實資料夾；symlink 是你刻意連進來的（例如 `~/dev` 下自己寫的 skill），不報告。`status` 會顯示 doctor 找到的問題數。

### 7.9 `skl adopt <set> [-y] [--dry-run]`

把 vendor 已經裝好的副本收進一個 installer 或 npm set：

1. 照常把 set 取到暫存區並規劃。
2. `~/.agents/skills` 下的無主資料夾，內容和要安裝的版本完全相同 → 直接收為受管，不搬動；只多了 installer 為 Codex 加的 `agents/openai.yaml` → 收為受管，但換成 skillport 的副本（原本那份進 trash）；其他不同 → 仍是撞名，照 §8 處理。
3. agent 目錄裡相同的副本 → 套用時移到 trash，讓 symlink 取代。這個 set 沒有連結的 link 資料夾（例如 `links: []` 時的 `~/.claude/skills`）除外：那份可能是該 agent 唯一讀得到的，保留不動。
4. 確認後套用，寫入 state。

skills-cli set 不需要 adopt：`npx skills` 自己決定要不要覆蓋，skillport 在委派前已經做撞名檢查（§5.1）。

### 7.11 `skl register [set] [--json '<entry>']`

方向鍵 wizard（@clack/prompts），一次完成註冊與第一次安裝：

1. 類型：Installer / npm package（GitHub repo 在 M2 前不可選）。
2. Installer：貼上 vendor 給的安裝指令。指令裡的 `--token=…` 會被抽出存進 Keychain，改寫成 `{secret}`；沒有 token 而 Keychain 已有這個 set 的 token 時，詢問是否沿用。未固定版本的套件提議固定到最新版。指令裡沒有 `--global` 之類的範圍旗標時才詢問。
3. 在沙盒跑一次 `<command> --help`（不帶 token），找出 `-y`、`--yes`、`--non-interactive`、`--no-input`，作為「自動更新時怎麼略過問題」的預設選項。
4. 多選要連結的 agent（目前只有已驗證的 Claude Code）；Codex、Cursor、OpenCode 直接讀 `~/.agents/skills`，只做說明。
5. 顯示 registry 內容，確認後寫入，接著詢問是否立刻安裝：installer 會在沙盒內互動執行，**由 vendor 自己的問題**決定裝哪些 skill、要不要改名，結果寫回 registry（§5.4）。

「假裝成哪個 agent」（`stage`/`harvest`）不再詢問，固定 `.claude`；需要時用 `--json` 指定。沒有終端機時用 `--json` 傳入整筆設定：先印出要寫入的內容，`--dry-run` 停在這裡，沒有終端機要加 `-y`。寫入前驗證：set id、必要欄位、npm 版本固定、`{secret}` 與 `secret` 一致、`links` 為已知目標，且拒絕 token 明文。

### 7.10 `skl resolve <set> <skill> (--prefix [p] | --rename <name> | --exclude | --undo)`

非互動處理撞名：寫進 registry（§8.4）；state 在下一次 `update` 套用時才更新。先印出「原本 → 之後」，`--dry-run` 停在這裡，終端機上確認，沒有終端機要加 `-y`。`--undo` 撤銷一條 `rename` 或 `exclude`。skills-cli set 只能 `--exclude` / `--undo`。

## 8. 撞名

一個 skill 名稱在 `~/.agents/skills` 只能對應一個目錄。撞名在寫入任何檔案之前偵測；`add`、`update`、`check`、`--dry-run`、`doctor` 都會檢查。

### 8.1 偵測與處理方式

| 撞到的對象 | 處理 |
|---|---|
| 另一個 set 的 skill（不論負責者） | **詢問**（§8.2） |
| `~/.agents/skills` 下不屬於任何負責者的目錄 | **詢問**，多一個「收進來（adopt）」選項 |
| `~/.claude/skills` 裡不是我們建立的項目 | **詢問** |
| Claude Code plugin 的 skill | **只警告**：plugin 有自己的 namespace（`plugin:skill`），不會覆蓋 |

### 8.2 互動提示

```
⚠ 撞名：prototype
  已安裝   matt           skills-cli   ~/.agents/skills/prototype
  新來源   animationsdev  installer    "Build multiple genuinely different versions…"

  要怎麼處理 animationsdev 的 prototype？
  ❯ 加前綴   → anim-prototype                 （前綴來自 registry 的 prefix，可修改）
    改名     → 自訂名稱
    排除     → 不安裝這個 skill
    改另一邊 → 不可用：matt 由 npx skills 管理，名稱由它決定
    中止
```

- 每個選項的新名稱都先驗證規則；仍然撞名時，下一輪規劃會再問一次。
- 「收進來」只在撞到無主目錄時出現，而且只作用在這一個 skill（含清理它在 agent 目錄裡的相同副本）：內容和這個 set 要裝的版本相同才會收進來，不同就再問一次（這時不再提供收進來）。`skl adopt` 才是整個 set 一起收。
- 「改另一邊」在另一邊是 skillport 管理、且能非互動執行的 set 時可選：輸入那邊 skill 的新名稱，規則立即寫進 registry（原因記為 `made room for set "<這個 set>"`），並先更新那個 set 讓出名稱，再繼續這個 set。另一邊是 `npx skills`、只能互動執行，或正在 `--dry-run` 時不可選，並說明原因。
- 「覆蓋另一邊」的條件和「改另一邊」相同：把那邊的 skill 寫成 `exclude` 規則並立即存檔，先更新那個 set（它的副本移到 trash），再安裝這邊的。適合另一邊的 skill 已經有更好的替代品時使用；用 `skl resolve <那個 set> <skill> --undo` 撤銷。
- 這個 set 自己的回答（加前綴、改名、排除）先放在草稿裡，套用後才寫進 registry；`--dry-run` 或回答「不套用」都不會寫入。
- skills-cli set 撞名時只能在自己這邊排除，或去改、覆蓋另一邊（skillport 管理的 set）。
- 非互動（`-y` 或沒有終端機）時不猜：中止，並印出可以直接執行的處理指令：
  ```
  skl resolve animationsdev prototype --prefix        # → anim-prototype
  skl resolve animationsdev prototype --rename <name>
  skl resolve animationsdev prototype --exclude
  ```

### 8.3 改名會連帶改動什麼

改名只作用在 skillport 負責的 skill（installer、npm）。skills-cli 的 skill 名稱由 `npx skills` 決定，skillport 不改。

| 改動 | 原因 |
|---|---|
| 目錄名稱 | 安裝位置 |
| `SKILL.md` frontmatter 的 `name` | 規格要求 `name` 等於目錄名；Codex 以 `name` 識別 skill |
| 同一個 set 內其他 skill 引用它的地方（`` `prototype` ``） | 否則引用會指向錯的 skill（例如 Matt 的 `prototype`） |

引用改寫的規則沿用現有實作：帶連字號的名稱一律改；單字名稱（`prototype`、`animate`）只在該行看得出是 skill 引用時改，其餘列出讓你確認。

### 8.4 記錄與追蹤

- **意圖記在 registry**（`rename` 或 `exclude`，附原因與日期）。這是可以手動編輯、可以放進版本控制的那一份。
- **結果記在 state**（安裝名稱、vendor 原名、原始內容的 hash）。
- `skl status` 會標示改過名的 skill：
  ```
  animationsdev  installer  15 skills   10/05 更新
                 prototype → anim-prototype   （撞名：matt/prototype，10/05）
  ```
- 之後如果撞名的對象消失（例如移除了 matt 的 `prototype`），`status` 會提示這條 `rename` 可以撤銷；vendor 把原 skill 改名或刪除時，提示這條規則已經沒有對象。

## 9. 安全

- Token 存在 macOS Keychain，不寫進 registry、state 或 log。錯誤訊息裡出現的 token 一律遮蔽。
- 已知限制：vendor installer 只接受命令列參數傳入 token，執行期間同使用者的其他行程可用 `ps` 看到。
- 寫入 Keychain 時，token 一律經由 stdin 交給 `security -i`，不放在命令列；只接受 token 常見字元（`A-Za-z0-9._~+/=:-`），其他字元要改用 `skl secret` 的終端機提示輸入。
- `@animationsdev/install@0.2.3` 預設 API 是 `http://animations.dev`，token 會先以明文送出再被 308 轉到 HTTPS。registry 範例固定加上 `--api=https://animations.dev`。
- `npm` 類型不執行套件程式碼，只解開檔案：只接受固定版本的 registry 套件，`npm pack` 一律帶 `--ignore-scripts`，並使用最小環境變數。npm 本身也接受 git URL 與 `owner/repo`，而對 git 來源會執行 repo 的 `prepare` script，所以這些寫法在讀 registry 與 wizard 兩處都被擋下（已驗證：用含 `prepare` 的本機 git repo 測試）。
- vendor 行程（installer、`--help` 偵測）只拿到最小環境變數：`PATH`、`TMPDIR`、語系與終端機設定、proxy 與 CA 設定，加上假 `HOME` 與 npm 設定。shell 裡的 API key、token、`SSH_AUTH_SOCK` 都不會傳過去。
- `register` 執行 installer 的 `--help` 前會先徵求同意，因為那就是在執行 vendor 的程式碼。
- 所有 npm/npx 子行程設 `logs-max=0`、`logs-dir` 指向 staging：npm 會把完整 argv（含 `--token=`）寫進 debug log（已驗證並修正）。npm 指令的 cwd 設在 staging，專案層的 `.npmrc` 無法改 registry。
- npm 的 `path` 與 installer 的 `harvest` 從根目錄一路往下，每一層都必須是真的資料夾：`package/skills -> /某個本機資料夾` 這種 symlink 會被拒絕（已驗證：macOS 的 tar 會保留封包裡的 symlink）。
- 指令前面的環境變數設定（`GITHUB_TOKEN=ghp_… npx …`）也用同一套字詞規則判斷，是憑證就抽出；執行時這些開頭的 `NAME=值` 會當成 installer 的環境變數（和 shell 一樣），不是指令名稱。 不得設定沙盒控制的變數（`HOME`、`PATH`、`TMPDIR`、`npm_config_*`（不分大小寫，因為 npm 讀設定不分大小寫）、`NODE_OPTIONS`、`NODE_PATH`、`LD_*`、`DYLD_*`），registry 讀取時與執行時都會擋；proxy、CA 憑證、語系這類傳遞變數可以覆寫；`--help` 偵測也會略過這些前綴。
- 任何字裡嵌著的憑證都會抓：網址裡的 `帳號:密碼@`、`Authorization: Bearer …` 標頭、常見前綴的 token（`ghp_`、`github_pat_`、`glpat-`、`npm_`、`xox?-`、`sk-`/`sk_live_`、`AKIA…`），不論前面有沒有旗標，也不論它在這個字的哪個位置（`--registry=https://u:密碼@…`、`--header=Authorization: Bearer …`）。token 前綴前面不能緊接字母或數字，所以 `risk-assess…` 不會被當成 `sk-…`；涵蓋 `sk-ant-…`、`sk-proj-…` 等真實格式。wizard 在把 skills-cli 來源交給 `npx skills` 之前就先檢查。registry 驗證涵蓋 `command`、`unattended` 與 skills-cli 的 `source`；`unattended` 也能用 `{secret}`。
- 憑證旗標以「字」比對：旗標名稱拆成字（以 `-`、`_` 與 camelCase 分隔）後，含 token、key、apikey、secret、auth、password、passwd、credential(s)、license、pat 其中之一就算；`--author`、`--keyboard`、`--no-*` 不算；最後一個字是 file、path、dir、method、type、mode、url、host、server、endpoint、name 時不算（`--key-file` 不算，`--host-token` 算）；值是路徑（`./`、`../`、`~/`，或 `/` 開頭且還有下一層的絕對路徑）不算；值是網址不算，除非網址裡有 `帳號:密碼@`；只有名稱恰為 `--license`、值為標準授權代號（MIT、Apache-2.0…）時不算。
- vendor 內容只接受一般檔案與目錄；symlink、FIFO 等在讀取前就拒絕（symlink 會把本機任意檔案帶進每個 agent 都讀的 skill，FIFO 會讓讀取永久卡住）。名稱在寫入任何檔案前驗證。

## 10. 可還原性

- 被取代、移除、`doctor --fix` 清掉的目錄都移到 `~/.agents/.skillport/trash/`，不刪除。
- 目錄替換是 rename（staging 與 skills 在同一個檔案系統），單一 skill 不會停在半寫入狀態。
- 已知限制：一次 update 多個 skill 時，中途失敗會留下「部分已更新」的狀態；trash 保有舊版，`doctor` 會報告不一致。
- 已知限制：lock 被接手的瞬間若同時有三個 skillport 在跑，可能兩個都拿到 lock；兩個 run 已被處理（接手後會確認搬走的是過期的 lock，不是就放回去）。 被擱置的 `lock.d.stale-*` 在下次取得 lock 時清掉（擁有者已不存在的才清）。

## 11. 從現況遷移

| 現況 | 遷移後 |
|---|---|
| Emil 的 skill 已移到 `~/.agents/_archive-2026-10-05/` | `skl add aiforui`、`skl add animationsdev` 重新安裝 |
| `~/.agents/skills/motion` 與 `~/.claude/skills/motion`（與 `motion-ai@14.1.0` 完全相同） | `skl adopt` 收進 `motion` set |
| `~/.claude/skills/motion-brief`（animationsdev 舊版，不受管理，內容和新版不同） | `adopt` 只收相同的副本，所以不會自動處理；2026-10-05 由你手動清掉，新版由 `animationsdev` set 安裝 |
| Matt：Claude plugin `mattpocock-skills@claude-community` | 改成 `matt` skills-cli set；你自己從 marketplace 移除 plugin |
| `~/dev/skillport` 現有程式碼 | 保留 acquire、staging、trash、Keychain；移除前綴與內文改寫 |

## 12. 已驗證與待驗證

### 已驗證

| 事實 | 依據 |
|---|---|
| Grok 讀 `~/.agents/skills` 與 `~/.claude/skills`；symlink 到同一目錄只列一次 | `grok -p` 測試 skill（grok 1.0.46） |
| Codex、Cursor、OpenCode 讀 `~/.agents/skills` | 各家官方文件 |
| Claude Code 只讀 `~/.claude/skills`，支援 symlink 目錄 | 官方文件 |
| Cursor 遞迴掃描 skill 根目錄 | 官方文件 |
| Skill 名稱規則：`^[a-z0-9]+(-[a-z0-9]+)*$`，需等於目錄名 | Agent Skills 規格、OpenCode 文件 |
| Emil installer 用 `os.homedir()` 偵測與寫入；`-y` 寫入所有偵測到的 agent | `@aiforui/install@0.1.4`、`@animationsdev/install@0.2.3` 原始碼 |
| Node `os.homedir()` 跟隨 `$HOME` | 本機測試 |
| 假 `$HOME` 的流程能完整產出 aiforui（28）、animationsdev（16）skill | 用真實 token 跑過 dry run（以 Codex 為目標） |
| `motion-ai` 非 TTY 拒絕執行；skill 內容放在 `content/skills` | 原始碼 |
| `npx skills` 1.7.0 有 `add -a/-s/-y`、`update`、`remove`，沒有 `check` | `--help` |
| `skillFolderHash` 是 skill 目錄的 git tree hash | 本機 13/16 吻合 |
| Codex 的 `agents/openai.yaml` 是選用 metadata | 官方文件 |
| 以 `.claude` 為目標時，產出和 Codex 目標相同（28 個 skill，只差 `agents/`） | M0：真 token 各跑一次，`diff -rq` |
| `npx skills -a codex -a claude-code` 把實體放 `~/.agents/skills`、為 Claude 建相對 symlink；逗號寫法被拒；只給 `-a claude-code` 會把實體寫進 `~/.claude/skills` | M2：在假 `$HOME` 安裝 `mattpocock/skills` 的 `tdd`（更正 M0 的逗號結論） |
| `npx skills add` 會覆蓋同名目錄而不警告 | M2：沙盒實測 |
| GitHub API 取得子目錄 tree hash，和 `skillFolderHash` 相同 | M0：`contents/<parent>` 的 dir `sha` 與 `git/trees/HEAD:<path>` 都等於 lock 值 |
| `skills@1.7.0` 的 lock 是 `version: 3`，新增欄位 `pluginName` | M0 |

### 待驗證（實作第一步）

| 項目 | 驗證方法 | 不成立時 |
|---|---|---|
| `.skill-lock.json` 的 `version: 3` 格式在 `skills@latest` 不變 | 讀取時檢查 `version`，不符就停止並提示 | 固定 `npx skills` 版本 |
| `~/.agents/skills` 有 symlink 時，Cursor、OpenCode 會不會因為也讀 `~/.claude/skills` 而看到兩份 | 各開一次，看 skill 清單（OpenCode CLI 在此環境被系統終止，Cursor 的 `cursor-agent -p` 會用你的帳號額度，未代跑） | 文件記錄；必要時改由 Claude Code 用 `--add-dir` 等方式讀取 |

## 13. 里程碑

| 階段 | 內容 | 預估 |
|---|---|---|
| M0 | 驗證 §12 待驗證項目 | 1 小時 · **完成**（Cursor/OpenCode 重複顯示待你在 app 內確認） |
| M1 | registry / state、installer 與 npm 類型、`status`、`check`、`update`、`diff`、`secret`、`remove`、撞名處理與 `resolve` | 半天多 · **完成**（互動模式已用 pseudo-terminal 實測） |
| M2 | skills-cli 類型（委派 + GitHub hash 檢查） | 2–3 小時 · **完成** |
| M3 | `doctor`、`adopt`，完成 §11 遷移 | 2–3 小時 · **完成**（實際 `--fix` 由你執行） |

每個階段結束都附測試，且先在 scratchpad 的假目錄跑過才碰真實的 `~/.agents`。

## 14. 決定紀錄

| # | 問題 | 決定 | 日期 |
|---|---|---|---|
| 1 | Matt 改用 skills-cli set | 是；plugin 由你從 marketplace 移除 | 2026-10-05 |
| 2 | 撞名處理 | 互動詢問：加前綴 / 改名 / 排除；記錄在 registry 與 state（§8） | 2026-10-05 |
| 3 | 還原 8 個 Emil skill 的 `"off"` 設定 | 不還原 | 2026-10-05 |
| 4 | Grok 納入第一版 | 是；驗證結果：直接讀 `~/.agents/skills`，不需連結 | 2026-10-05 |
| 5 | 工具名稱 | 沿用 `skillport`；指令 alias `skl` | 2026-10-05 |
| 6 | `skl add` 對 installer 預設互動 | 是；第一次安裝由你勾選 skill，之後 update 重播記錄 | 2026-10-05 |
| 7 | `capture` 指令 | 不做；`-i` 已涵蓋，沒有 `unattended` 就是「只能互動」（§5.4） | 2026-10-06 |
| 8 | installer 卡在問題時 | 回報「需要你」並以 0 結束，不中斷其他 set | 2026-10-06 |
| 9 | 「改另一邊」 | 只對能非互動執行的 skillport set 開放；規則立即存檔並先更新那個 set | 2026-10-06 |
| 9a | 「覆蓋另一邊」 | 和「改另一邊」同條件；在另一邊寫 `exclude`，舊副本進 trash | 2026-10-06 |
| 10 | skills-cli 檢查的連結 | 給 GitHub 資料夾的 commit 歷史，不給 compare（lock 沒有 commit） | 2026-10-06 |
| 11 | 沒登入 `gh` | 改用 GitHub 公開 API（curl），不另加依賴 | 2026-10-06 |
| 12 | 非 GitHub 的 skills-cli 來源 | 檢查標為「can't tell」，`update` 直接重抓；不另做機制 | 2026-10-06 |
| 13 | Gemini CLI 連結目標 | 暫不加入 `LINK_TARGETS`：未驗證它讀哪個目錄，且 `gemini -p` 驗證會用你的額度 | 2026-10-06 |
