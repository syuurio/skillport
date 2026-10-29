# skillport 設計規格

這是 skillport v2 的規格，取代 v1。實作計畫在 [plans/skillport-v2.md](plans/skillport-v2.md)，追蹤在 Linear LAB-12。

## 1. 問題

skill 從三種管道進來：GitHub repo（`npx skills add`）、帶 token 的第三方 installer（`@aiforui/install`、`@animationsdev/install`），以及 npm 套件（`motion-ai`）。現況有三個痛點：

1. **不知道 skill 屬於誰。** 在 agent 裡輸入 `/tdd` 時，看不出它來自哪個來源，也記不住每個來源有哪些 skill。
2. **撞名。** 不同來源可能提供同名的 skill。
3. **分散管理。** 每種 installer 各有各的安裝與更新方式。

v1 已經集中管理 installer 與 npm，但 `npx skills` 的 skill 名稱屬於 `npx skills`，不能改名，所以痛點 1 和 2 在 GitHub 來源上仍然存在。

## 2. 目標

- 一份 manifest 列出所有來源，用同一組指令與 TUI 查看、檢查、更新。
- 每個受管 skill 預設以來源 id 當前綴，看名稱就知道來源，不同來源也不會撞名。
- 修改某個 skill 之後，仍然能接收上游更新。
- 適用所有遵循 Agent Skills 規格的 agent，不依賴特定 agent 的私有機制。
- 你自己直接用 `npx skills` 裝的 skill 照常運作，skl 只讀不寫。

### 非目標

- 不取代 `npx skills`：GitHub 來源仍由它下載，只是在 skl 私有的位置執行。
- 不做 Claude Code plugin 的冒號命名（`/source:skill`）。
- 這一版不做：rollback 與多版本保留、`skl release`、在 description 加來源標記、installer 的完整內容比對（`--deep`）。skl 本身不呼叫 agent：要 agent 幫忙改 skill 或解衝突，靠的是 §10.1 的兩個 skill。

## 3. 名詞

| 名詞 | 意思 |
|---|---|
| **來源（source）** | manifest 裡的一筆設定，例如 `matt`、`aiforui`。id 由你決定，不必和套件名稱相同 |
| **原名** | vendor 提供的 skill 名稱，例如 `tdd` |
| **身分（SkillId）** | `來源/原名`，例如 `matt/tdd`。更新追蹤、hash、patch 都以它為準 |
| **安裝名稱** | 實際寫進 `~/.agents/skills` 的名稱，例如 `matt-tdd`。由身分和命名規則算出來 |
| **store** | 存放 vendor 原始內容的地方，一律原名 |
| **輸出** | 從 store 依規則產生安裝名稱的資料夾，寫進 `~/.agents/skills` |
| **外部 skill** | 不歸 skl 管的 skill：你直接用 `npx skills` 裝的、手動放的資料夾 |
| **shadow HOME** | 每個 GitHub 來源專用的假 HOME，`npx skills` 在裡面執行 |

## 4. 架構

```
manifest ──▶ adapters ──▶ store ──▶ 輸出 ──▶ ~/.agents/skills ──symlink──▶ 各 agent 目錄
(rules, patches)  github     (原名)    patch → prefix → refs     (Codex、Cursor、OpenCode 直接讀)
                  installer
                  npm / local
```

- **adapter** 只負責一件事：交出原名的 skill 資料夾和來源資訊。所有來源類型走同一條流程，改名、撞名、link、trash 的規則只有一份。
- **store** 只新增不修改，lock 記錄每個身分目前用哪一份。
- **輸出** 依序套用 patch、前綴或改名、改寫 skill 之間的引用，寫入 `~/.agents/skills`，再依 `targets` 建 symlink。
- **身分不變，安裝名稱可變。** 改前綴只需要從 store 重新輸出，不連網，也不重跑 installer。

## 5. 資料格式

### 5.1 Manifest（你編輯，或由指令寫入）

位置：`~/.config/skl/manifest.json`。

```json
{
  "version": 2,
  "targets": ["claude-code"],
  "linkTargets": {
    "claude-work": { "label": "Claude Code (work)", "dir": "~/.claude-work/skills" }
  },
  "sources": {
    "matt": {
      "type": "github",
      "repo": "mattpocock/skills",
      "pick": ["tdd", "code-review", "grilling"]
    },
    "aiforui": {
      "type": "installer",
      "command": ["npx", "-y", "@aiforui/install@0.1.4", "--token={secret}", "--global"],
      "unattended": ["-y"],
      "secret": "keychain",
      "links": ["claude-code", "claude-work"]
    },
    "anidev": {
      "type": "installer",
      "command": ["npx", "-y", "@animationsdev/install@0.2.3", "--token={secret}", "--global"],
      "unattended": ["-y"],
      "secret": "keychain",
      "rename": { "prototype": "anidev-proto" }
    },
    "motion": {
      "type": "npm",
      "package": "motion-ai@14.1.0",
      "path": "content/skills",
      "prefix": false
    },
    "mine": { "type": "local", "path": "~/dev/my-skills" }
  }
}
```

共用欄位（所有類型）：

| 欄位 | 說明 |
|---|---|
| `prefix` | 省略 = 來源 id；字串 = 自訂前綴；`false` = 不加前綴 |
| `rename` | 原名 → 安裝名稱，優先於前綴 |
| `pick` | 要安裝的原名。省略 = 第一次安裝時全部；之後上游新增的 skill 只列出，不自動安裝。`local` 例外：資料夾裡新增的 skill 下次 sync 就安裝 |
| `exclude` | 不安裝的原名 |
| `links` | 這個來源要連結的目標，省略 = 最上層的 `targets` |

各類型的欄位：

| 類型 | 欄位 |
|---|---|
| `github` | `repo`：`owner/repo` 或 GitHub 網址 |
| `installer` | `command`：完整 argv，`{secret}` 執行時替換；`unattended`：非互動執行時附加的旗標，省略 = 只能互動執行；`secret`：`"keychain"`；`stage` / `harvest`：沙盒裡的相對路徑，預設 `[".claude"]` / `".claude/skills"` |
| `npm` | `package`：固定版本的 `name@x.y.z`；`path`：套件內 skill 目錄的相對路徑 |
| `local` | `path`：絕對路徑或 `~/` 開頭 |

`targets` 的內建值是 `claude-code`（`~/.claude/skills`）；`linkTargets` 加自己的目標，規則同 v1（絕對路徑或 `~/` 開頭、不得有 `..`、不得與 `~/.agents` 底下的路徑或其他目標重疊）。`~/.agents/skills` 本身不是 target，它是唯一的實體位置。

manifest 每次讀取都完整驗證（§6.2），有問題就停止並列出。token 永遠不寫進 manifest。

### 5.2 Lock（skl 寫入）

位置：`~/.agents/.skl/lock.json`。

```json
{
  "version": 2,
  "sources": {
    "matt": { "resolved": "59db609eb1e18aaf59b63284d0e52255aff0c63c", "syncedAt": "2026-10-29T08:00:00Z", "seen": ["tdd", "code-review", "grilling", "prototype", "wizard"] },
    "aiforui": { "resolved": "@aiforui/install@0.1.4", "syncedAt": "2026-10-29T08:00:00Z", "seen": ["color", "typography"] },
    "motion": { "resolved": "motion-ai@14.1.0", "syncedAt": "2026-10-29T08:00:00Z", "seen": ["motion"] }
  },
  "skills": {
    "matt/tdd": {
      "name": "matt-tdd",
      "base": "667dbdd00c09d0e2189e082986e6a4d61a67c2a6",
      "output": "1b9e04c…",
      "updatedAt": "2026-10-29T08:00:00Z"
    },
    "aiforui/color": {
      "name": "aiforui-color",
      "base": "9f2c…",
      "output": "c41d…",
      "patch": "e07a…",
      "updatedAt": "2026-10-29T08:00:00Z"
    }
  }
}
```

| 欄位 | 說明 |
|---|---|
| `sources.<id>.resolved` | 實際安裝的版本：GitHub 是 commit，installer 與 npm 是固定版本，local 是資料夾 tree hash |
| `sources.<id>.seen` | 上游提供過、已經讓你看過的原名。不在 `seen` 裡的才算「新」 |
| `skills.<id>.name` | 安裝名稱 |
| `skills.<id>.base` | store 裡 vendor 原始內容的 tree hash，和上游比對用 |
| `skills.<id>.output` | 實際寫進 `~/.agents/skills` 的 tree hash，和磁碟比對用 |
| `skills.<id>.patch` | 有客製時，patch 檔的 hash |

hash 一律是 git tree hash，和 GitHub 的資料夾 hash、`npx skills` 的 `skillFolderHash` 同一種算法。

### 5.3 目錄配置

```
~/.config/skl/
  manifest.json
  patches/<source>/<skill>.patch      客製的差異
  patches/<source>/<skill>.note.md    為什麼要改
~/.agents/
  skills/<安裝名稱>/                    agent 實際讀取的位置
  .skill-lock.json                     你自己的 npx skills lock（skl 只讀）
  .skl/
    lock.json
    status.json
    store/<source>/<skill>/<hash>/     vendor 原始內容，一律原名
    cli/<source>/                      GitHub 來源的 shadow HOME
      .agents/skills/<原名>/
      .agents/.skill-lock.json
    work/<source>/<skill>/             skl edit 的工作區
    merge/<source>/<skill>/            合併衝突時的資料夾
    trash/<時間>/                       被替換或移除的資料夾
    lock.d/                            同一時間只跑一個 skl
~/.claude/skills/<安裝名稱> → ~/.agents/skills/<安裝名稱>
```

`SKILLPORT_HOME` 會把以上所有路徑搬到另一個資料夾，測試與沙盒驗證都用它。

**換電腦。** 放進 dotfiles 的只有 `~/.config/skl/`（manifest、patch、note），`~/.agents/.skl/` 都能重新產生，不要放。在新電腦上：

1. 放回 `~/.config/skl/`。
2. 需要 token 的 installer 來源，先執行 `skl secret <source>`。Keychain 不會跟著 dotfiles 走。
3. 執行 `skl update -y`：依 manifest 抓每個來源、套用 patch，再輸出。`skl sync` 不連網，所以沒抓過的 vendor 來源它裝不了，會列出來並提示改用 `skl update`。

上游如果在你做 patch 之後改過，第一次安裝時 patch 可能套不上。這時這個 skill 不會安裝，會列為 conflict：`MERGED/` 是新上游加上還套得上的 hunk，套不上的放在旁邊的 `.rej` 檔。手動套用並刪掉 `.rej` 之後，執行 `skl edit <source>/<skill>` 就會完成並安裝。

store 每個身分保留目前的 `base`；有 patch 的身分另外保留 patch 依據的那一份，直到合併完成。其他舊版本在替換時移到 trash。

### 5.4 status.json（skl check 寫入）

位置：`~/.agents/.skl/status.json`。`skl status` 與 TUI 只讀這個檔案，不連網。

```json
{
  "checkedAt": "2026-10-29T08:00:00Z",
  "sources": {
    "matt": {
      "state": "updates",
      "from": "4f2a91c", "to": "b81e0d3",
      "changed": ["tdd", "code-review"],
      "added": ["implement-spec"],
      "removed": [],
      "link": "https://github.com/mattpocock/skills/compare/4f2a91c...b81e0d3"
    },
    "aiforui": { "state": "pinned-behind", "current": "0.1.4", "latest": "0.1.5" },
    "motion": { "state": "up-to-date" },
    "remotion": { "state": "unknown", "reason": "GitHub unreachable" },
    "emil-pro": { "state": "error", "reason": "token invalid" },
    "legacy": { "state": "blocked", "collisions": [{ "name": "tdd", "with": "external npx skills install" }] }
  },
  "skills": {
    "aiforui/color": { "customized": true },
    "matt/grilling": { "edited": true },
    "anidev/gesture": { "conflict": "~/.agents/.skl/merge/anidev/gesture" }
  }
}
```

每個來源另外帶自己的 `checkedAt`（範例省略）：`skl check <source>` 只檢查部分來源時，其他來源保留上次的結果與時間。來源的 `state` 只會是 `up-to-date`、`updates`、`pinned-behind`、`unknown`、`error`、`blocked` 其中之一，各自帶不同欄位。skill 的旗標：`customized`（有 patch）、`edited`（磁碟和 `output` 不符）、`conflict`（合併衝突，值是 merge 資料夾）。

### 5.5 Patch 與 note

```
~/.config/skl/patches/aiforui/color.patch
~/.config/skl/patches/aiforui/color.note.md
```

- patch 是 unified diff，對象是 **原名版本**（store 裡的內容），不是輸出後的版本。所以改前綴不影響 patch。
- note 是你寫的修改原因，合併衝突時給人或 agent 判斷意圖。沒有 note 時 `skl status` 與 `skl doctor` 會提醒。
- 這個資料夾可以和 manifest 一起放進你的 dotfiles git。

## 6. 命名

### 6.1 安裝名稱怎麼算

依序套用，第一條成立就停：

1. `rename` 有這個原名 → 用它。
2. `prefix` 是 `false` → 原名。
3. 原名等於前綴，或已經以 `<前綴>-` 開頭 → 原名（避免 `emil-emil`、`emil-emil-color`）。
4. 其他 → `<前綴>-<原名>`，前綴省略時是來源 id。

| 來源 | 設定 | 原名 | 安裝名稱 |
|---|---|---|---|
| `matt` | 無 | `tdd` | `matt-tdd` |
| `anidev` | 無 | `gesture` | `anidev-gesture` |
| `anidev` | `rename: { prototype: "anidev-proto" }` | `prototype` | `anidev-proto` |
| `motion` | `prefix: false` | `motion` | `motion` |
| `emil` | 無 | `emil-color` | `emil-color` |

前綴只能用 `-` 分隔：Agent Skills 規格的 `name` 只允許小寫英數與單一連字號、最多 64 個字元，並且必須和資料夾名稱相同。

### 6.2 讀 manifest 時就擋下的錯誤

這些不需要知道上游有哪些 skill，manifest 一讀進來就檢查：

| 錯誤 | 例子 | 訊息 |
|---|---|---|
| 來源 id 不合規格 | `"Anim_Dev"` | `sources.Anim_Dev: id must be lowercase letters, digits and single hyphens` |
| 兩個來源的前綴相同 | `aiforui` 預設前綴 `aiforui`，`anidev` 設 `prefix: "aiforui"` | `sources.anidev.prefix "aiforui" is already used by sources.aiforui` |
| `rename` 的目標不合規格 | `rename: { x: "my--x" }` | `sources.anidev.rename.x "my--x" is not a valid skill name` |
| 兩條 `rename` 指向同一個名稱 | 兩個來源都 rename 成 `proto` | `"proto" is the rename target of both sources.a and sources.b` |
| manifest 裡出現 token | `--token=ghp_…` | `sources.aiforui.command contains a credential; use {secret}` |

### 6.3 知道 skill 清單後才能發現的撞名

這些要等 adapter 交出 skill 清單（`add`、`sync`、`check`、`update`）才知道。發生時停下來，不寫入任何東西；在 `check` 裡則把來源標成 `blocked`：

| 情況 | 例子 |
|---|---|
| 兩個來源算出同一個安裝名稱 | `a` 的 `b-c` 和 `a-b` 的 `c` 都是 `a-b-c` |
| 安裝名稱超過 64 個字元 | 前綴加上很長的原名 |
| 撞到外部 npx skills 的 skill | `motion`（`prefix: false`）撞到你用 `npx skills` 裝的 `motion` |
| 撞到 `~/.agents/skills` 裡的無主資料夾 | 你手動放的 `~/.agents/skills/motion/` |
| 撞到 target 裡不是 skl 建立的東西 | `~/.claude/skills/matt-tdd` 是一個實體資料夾 |
| 上游新增的 skill 撞名 | `matt` 新增的 `grilling` 在 `prefix: false` 時撞到外部 skill |

訊息會說明是哪兩個、要改 manifest 的哪裡，例如：

```
motion/motion would install as "motion", which is taken by an external npx skills install.
Fix: set sources.motion.prefix, or add sources.motion.rename.motion.
```

不做互動式的撞名選單。前綴預設開啟，撞名很少見，清楚的錯誤訊息比選單簡單。Claude Code plugin 提供的同名 skill 有自己的命名空間，只顯示提示，不算撞名。

## 7. 來源類型

每種 adapter 都實作兩件事：**fetch** 交出原名資料夾，**check** 判斷上游有沒有變。

### 7.1 `github`

- **fetch**：在 shadow HOME（`~/.agents/.skl/cli/<source>/`）先用 `git ls-remote <url> HEAD` 取得 commit，再執行 `npx -y skills@1.7.0 add <url>#<commit> -g -a codex -s '*' -y`，從 `<shadow>/.agents/skills/*` 取出放進 store。指定 commit 有兩個用途：裝進來的就是記下的那個 commit；npx skills 也一定走 git clone。沒有 ref 時，vercel、vercel-labs 等少數 owner 的 repo 會改從 skills.sh 下載快照。快照會保留 `metadata.json`、拿掉執行權限，內容也可能落後 HEAD。每個 skill 在 repo 裡的資料夾（shadow lock 的 `skillPath`）記在 lock 的 `sources.<id>.paths`。
- **列出可選的 skill**：`npx skills add <repo> --list`，解析文字輸出（它不接受 `--json`）。
- **check**：先 `git ls-remote`。commit 和 lock 一樣就代表整個來源沒變；不一樣才呼叫一次 `GET repos/<repo>/git/trees/<commit>?recursive=1`，一次比對所有 skill 的資料夾 hash。資料夾依 `paths` 找，hash 由清單重算，並扣掉 npx skills 複製時略過的檔案（`metadata.json`、`.git`、`__pycache__`、`__pypackages__`）。先用 `gh api`，沒有登入時用公開 API。
- 環境變數只傳最小集合，不傳 `XDG_STATE_HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`，否則 `npx skills` 會寫到真正的位置。
- shadow HOME 一直保留，裡面的 lock 是一份真正的 npx skills lock，只是名稱一律原名。

### 7.2 `installer`

- **fetch**：同 v1。`command` 原樣執行，`HOME` 指向只含 `stage` 的沙盒，結束後取 `harvest` 底下的資料夾。非互動執行時附加 `unattended`；沒有 `unattended` 的來源只在 `-i` 時執行，installer 拿到真正的終端機。
- **check**：如果 `command` 是 `npx <套件>@<版本>`，用 `npm view` 看有沒有新版，有就是 `pinned-behind`。installer 從 vendor 伺服器下載的內容可能在版本不變時更新，`skl update` 會實際執行一次並比對 hash。
- installer 的新版本只提示，不自動升級；升級是改 manifest 裡的版本號。

### 7.3 `npm`

- **fetch**：`npm pack` 固定版本，取出 `path`，不執行任何套件程式碼。
- **check**：`npm view` 比對版本。

### 7.4 `local`

- **fetch**：讀 `path` 底下每個含 `SKILL.md` 的子資料夾。
- **check**：重新計算資料夾 hash。適合你自己寫的 skill，以及測試。

## 8. 輸出

對每個身分：

1. 從 store 取 `base`。
2. 有 patch 就套用。
3. 依 §6.1 算出安裝名稱，改資料夾名稱與 frontmatter 的 `name`。
4. 改寫這個來源的 skill 之間的引用（例如內文寫「use the `tdd` skill」改成 `matt-tdd`）。
5. 在 frontmatter 的 `metadata` 寫入來源，保留原有的其他鍵：

   ```yaml
   metadata:
     skl-source: matt
     skl-original: tdd
   ```

6. 寫入 `~/.agents/skills/<安裝名稱>`：整個資料夾替換，舊的移到 trash；不做逐檔覆寫，所以 vendor 刪掉的檔案不會殘留。
7. 依 `links`（或 `targets`）建 symlink。只移除 skl 自己建的 link。

改寫引用是文字比對，可能漏改或改錯，所以計畫與 `skl diff` 會列出每一處改寫。skl 只改寫 skill 之間的引用，你自己的 CLAUDE.md、AGENTS.md 裡的名稱不會被改到。

## 9. 外部 skill

- **你的 npx skills**：讀 `~/.agents/.skill-lock.json`，只讀。你的 `npx skills update` 照常運作，用它裝的 skill 沒有前綴。
- **無主資料夾**：`~/.agents/skills` 裡不在 lock 也不在 npx skills lock 的資料夾。
- **target 裡的其他東西**：不是 skl 建立的檔案、資料夾或 link。

它們只用在撞名檢查與 `doctor`，skl 不會修改或刪除。

`skl adopt <npx skills 來源>` 把外部的 GitHub 來源接過來：先在 shadow HOME 安裝並輸出成功，才對原本的 skill 執行 `npx skills remove`（這是真的刪除）。任一步失敗就不移除原本的。

## 10. 客製化與合併

- 客製化的方式是直接改 `~/.agents/skills/<安裝名稱>` 裡的檔案，再執行 `skl edit <source>/<skill> --from-disk --note "<原因>"` 把改動存成 patch（做法見下面「直接改了」）。沒有 `--note` 時，在終端機上會問一次原因（可以跳過）；`--note` 會取代原本的 note。
- `skl edit <source>/<skill> --drop`：把 patch 與 note 移到 trash，恢復上游原版。
- 加 `--dry-run` 時只印出會存的 patch（或會移除的 patch），不寫入任何東西。
- 不加旗標的 `skl edit <source>/<skill>` 只用來完成合併；沒有合併等著時會提示改用 `--from-disk`。
- 更新時，有 patch 的 skill 逐檔執行 `git merge-file`：

  | 角色 | 內容 |
  |---|---|
  | BASE | 舊上游（patch 依據的那一份） |
  | UPSTREAM | 新上游 |
  | YOURS | 舊上游 + patch |

  新增與刪除的檔案另外處理：只有一邊動到就採用那一邊，兩邊都動到算衝突。

- **乾淨合併**：計畫裡顯示 `patch reapplied`，套用後以新上游為基準重新產生 patch。
- **有衝突**：這個 skill 標成 `conflict`，列在計畫的 Held back，不在套用範圍內；輸出維持舊版，其他 skill 照常更新。skl 準備 `merge/<source>/<skill>/`，放入 `BASE/`、`UPSTREAM/`、`YOURS/`、`MERGED/`（衝突處有 `<<<<<<< YOURS` 標記）、`note.md`、`your.patch` 與 `merge.json`（記錄 BASE 與 UPSTREAM 的 hash）。同一組版本的資料夾已經存在時不會重建，所以你在 `MERGED/` 的進度不會被下一次 sync 蓋掉。解決方式：改好 `MERGED/`（解掉所有衝突標記、手動套用 `.rej` 並刪掉），再執行 `skl edit <source>/<skill>`。它以 `MERGED/` 和新上游的差異作為新的 patch，接著安裝並刪掉 merge 資料夾。`MERGED/` 還有 `.rej` 或衝突標記時會拒絕。你可以自己處理，或交給 agent（§10.1 的 `skillport-merge`）。
- **patch 套不上**（例如在新機器上 patch 的基準不同）：同樣算衝突，`MERGED/` 是新上游的副本。

- **直接改了 `~/.agents/skills` 裡的檔案**（沒有透過 `skl edit`）：磁碟的 tree hash 和 lock 的 `output` 不同，這個 skill 標成 `edited`。`sync` 與 `update` 都不覆蓋它，只列在 Held back，並保留它目前的名稱供其他 skill 的引用使用。兩個出口：
  - `skl edit <source>/<skill> --from-disk`：把磁碟上的改動轉成 patch。先還原 skl 自己做的改寫（安裝名稱、`metadata` 的 `skl-*` 鍵、引用改寫），再和 store 裡的原名版本比對，之後就走上面的合併流程。還原有兩種做法，依序嘗試：逐項反向改寫，或以 skl 寫出的版本為 BASE 做三方合併。結果必須能重新輸出成和磁碟完全相同的資料夾才採用；兩種都不行，代表你改到了 skl 也會改寫的那一行（例如 `name`），skl 會拒絕並說明怎麼做。
  - `--discard-edits`（`sync` 或 `update`）：換回 skl 的版本，你的那份移到 trash。

### 10.1 給 agent 用的 skill

repo 的 `skills/` 有兩個 skill，由 agent 自己判斷何時使用，教它用上面的指令操作。skl 不呼叫 agent。

| skill | 用途 |
|---|---|
| `skillport-edit` | 使用者要改某個 skill 時：用 `skl which` 找 id，用 `skl status --json` 看狀態，直接改安裝資料夾，`--from-disk --dry-run` 預覽後用 `--note` 存檔 |
| `skillport-merge` | 有衝突時：讀 note、`your.patch`、`BASE` 與 `UPSTREAM` 的差異，在 `MERGED/` 帶入原本的意圖，`--dry-run` 預覽後完成 |

安裝：`skl add skillport --github syuurio/skillport`，原名是 `edit` 與 `merge`，加上前綴就是上面的名稱。修改這兩個 skill 時，改用 `--local <clone>/skills`，`skl update skillport` 不用 push 就會套用。

`skl status --json` 是給 agent 讀的：`sources` 是每個來源的狀態，`skills` 列出每個 skill 的 `id`、安裝名稱、資料夾、patch 與 note 的路徑、`edited`，以及衝突時的 `conflict.dir`。

## 11. 指令

所有輸出用英文。`--dry-run` 只印計畫；`-y` 跳過確認；沒有終端機時，要寫入的指令必須加 `-y`。

| 指令 | 說明 |
|---|---|
| `skl` | 在終端機裡打開 TUI；沒有終端機時同 `skl status` |
| `skl add <id> --github <repo> \| --installer "<command>" \| --npm <pkg@ver> --path <dir> \| --local <dir>` | 寫入 manifest、需要時把 token 存進 Keychain、選擇 skill，然後安裝 |
| `skl sync [--discard-edits]` | 讓磁碟符合 manifest 與 lock，不連網。直接改過的 skill 保留不動，除非加 `--discard-edits` |
| `skl check [source...]` | 檢查更新，寫入 `status.json`，不改動 skill |
| `skl status [--json]` | 讀 `status.json`，不連網；`--json` 輸出給 agent 讀（§10.1） |
| `skl update [source...] [-i] [--pick] [--discard-edits]` | 列出計畫，在終端機上勾選新 skill，確認後套用；`conflict` 與 `edited` 不套用 |
| `skl which <安裝名稱>` | 來源、原名、版本、最後更新時間 |
| `skl diff <source>[/<skill>] [-i]` | 抓取來源，用 diff 顯示下一次更新會怎麼改磁碟上的 skill，包含引用改寫與 patch；不寫入任何 skill |
| `skl edit <source>/<skill> [--from-disk \| --drop] [--note "<原因>"] [--dry-run]` | `--from-disk` 把直接改過的檔案存成 patch；`--drop` 恢復上游原版；不加旗標時完成合併（§10） |
| `skl adopt <npx skills 來源>` | 接管外部的 GitHub 來源 |
| `skl remove <source> [-y] [--discard-edits]` | 確認後把來源的所有 skill 移到 trash、移除 link，並從 manifest 刪除。patch、note 與 Keychain token 保留。有直接改過的 skill 時拒絕，除非加 `--discard-edits` |
| `skl secret <source>` | 把 token 存進 Keychain |
| `skl doctor [--fix]` | 散落的副本、壞掉或缺少的 link、`edited` 的 skill、沒有 note 的 patch。`--fix` 只做安全的修正 |
| `skl schedule [daily [--at HH:MM] \| off]` | 用 macOS launchd 每天執行 `skl check --notify`；`skl check --notify` 只對還沒通知過的更新發系統通知 |
| `skl migrate [--dry-run]` | 從 v1 遷移（§14） |

`skl status` 的輸出：

```
SOURCE          TYPE        STATE                           CHECKED
matt            github      2 updates · 1 new               2h ago
aiforui         installer   installer 0.1.5 available       2h ago
motion          npm         up to date (pinned 14.1.0)      2h ago
remotion        github      can't tell: GitHub unreachable  2h ago
emil-pro        installer   token invalid: run skl secret   2h ago
legacy          local       blocked: name collision         2h ago
```

`skl update` 的計畫分成兩段。第一段是要套用的變更；第二段是 skl 不會動、要你處理的 skill，它們不在套用範圍內，也不會出現在選擇清單裡：

```
matt  4f2a91c → b81e0d3
  replace   matt-tdd
  replace   matt-code-review
  new       implement-spec, deploy
aiforui
  replace   aiforui-color      patch reapplied

Held back (not applied):
  conflict  anidev-gesture     you and upstream changed the same lines
            resolve in ~/.agents/.skl/merge/anidev/gesture
  edited    matt-grilling      changed in place in ~/.agents/skills
            keep your edits:   skl edit matt/grilling --from-disk
            discard them:      skl update matt --discard-edits

New skills in matt. Install any? (space to toggle, enter to confirm)
  ◻ implement-spec
  ◻ deploy
Apply? (y/N)
```

- `new`：vendor 來源上游新增、還沒看過的 skill。在終端機上直接勾選要不要裝；沒勾的記進 lock 的 `seen`，之後不再詢問，想裝時用 `skl update <source> --pick` 重新挑。沒有終端機或加 `-y` 時只列出，不安裝也不記成看過。`local` 來源的新 skill 不經詢問，直接列在 `new` 並安裝（§5.1）。
- `conflict` 與 `edited` 一律只列在 Held back：輸出維持現狀，同一來源的其他 skill 照常更新。
- `blocked`：已安裝來源的新 skill，安裝名稱被外部 skill、無主資料夾或 target 裡的東西占用。只有它不安裝、不記成看過，其他來源與 skill 照常更新；`skl check` 會持續把來源標成 blocked，直到你改 prefix 或 rename。新加入的來源（`skl add`）則整個來源一起成功或失敗。
- `Apply?` 只涵蓋第一段與勾選的新 skill。

## 12. TUI

```
 skillport                                       checked 2h ago · r to re-check
┌ Sources ───────────────────────────┬ matt · mattpocock/skills ─────────────────┐
│ ● matt           2 updates · 1 new │  matt-tdd           update   4f2a91c→b81e0d3 │
│ ● aiforui        installer 0.1.5   │  matt-code-review   update                   │
│ ✓ motion         pinned 14.1.0     │  implement-spec     new upstream (not picked)│
│ ✗ emil-pro       token invalid     │  matt-grill         customized               │
└────────────────────────────────────┴──────────────────────────────────────────────┘
 ↑↓ select  u update  U update all  d diff  o open link  space pick new  r re-check  q quit
```

| 按鍵 | 動作 |
|---|---|
| `↑` `↓` | 選擇來源；右側有焦點時選擇 skill |
| `←` `→` | 在來源與 skill 兩側之間切換 |
| `u` | 右側換成這個來源的更新計畫，`y` 套用、`Esc` 返回 |
| `U` | 所有來源的計畫一起列出、確認一次；只能互動執行的 installer 跳過並標出 |
| `d` | 顯示選中 skill 的 diff |
| `o` | 開啟 compare 連結 |
| `space` | 勾選上游新增的 skill |
| `r` | 重新執行 check |
| `q` | 離開 |

- `blocked` 的來源按 `u` 只顯示撞名細節與要改的 manifest 欄位。
- 缺 token 的來源（`skl check` 回報 `token missing`：installer 用了 `{secret}`，Keychain 裡卻沒有）按 `u` 改成輸入 token，畫面只顯示 `•`，存進 Keychain 後重新檢查。
- 只能互動執行的 installer：TUI 暫停，把終端機交給 installer（Ink 的 `suspendTerminal`），結束後回來顯示計畫。
- `skl` 不在終端機上執行時（例如 `skl | cat`）只印 `skl status` 的表格。
- TUI 呼叫的 check、plan、update 和 CLI 是同一套，沒有自己的更新邏輯。

## 13. 安全與可還原性

沿用 v1：

- installer 在沙盒 HOME 裡執行，只拿到最小化的環境變數，看不到 shell 裡的 secret。
- token 只存在 Keychain（service `skillport`，account = 來源 id），不會出現在 manifest、lock、log，或 skl 控制的命令列。
- vendor 內容含 symlink 或特殊檔案時拒絕。
- 替換或移除的資料夾移到 trash，不直接刪除。唯一的例外是 `npx skills remove`（`adopt` 與 `migrate` 時），它只在新的副本輸出成功後執行。
- 撞名在寫入前檢查，套用前再檢查一次。
- 同一時間只跑一個 skl（`lock.d`）。

## 14. 從 v1 遷移

`skl migrate [--dry-run] [-y] [--discard-edits]` 讀 v1 的 `~/.config/skillport/registry.json` 與 `~/.agents/.skillport/state.json`：

| v1 | v2 |
|---|---|
| `installer` set | `installer` 來源，id 不變 |
| `npm` set | `npm` 來源，id 不變 |
| `skills-cli` set（`owner/repo` 或 GitHub URL） | `github` 來源，`pick` 是 v1 裝過、npx skills lock 裡還在的 skill。先在 shadow HOME 安裝並輸出，確認後才對這些原名執行 `npx skills remove` |
| `skills-cli` set（其他來源或沒裝過） | 不遷移，列在計畫的 Not migrated |
| `namespace` | `prefix`；沒有 `namespace` 時是 `prefix: false` |
| `rename` | `rename`（只留目標名稱） |
| `links`、`linkTargets` | 同名欄位 |
| state 的 `declined` | 不安裝：`pick` 只列 v1 裝了的 skill |
| Keychain 的 token | 沿用，不必重新輸入 |

installer 與 npm 的 skill 保留 v1 的安裝名稱，所以 agent 裡的指令不變，v1 建的 link 也繼續有效。github 來源用預設前綴（來源 id），計畫會列出每個「舊名稱 -> 新名稱」，確認後才執行。

遷移不會留下半套狀態：

- 抓取失敗、上游不再提供某個 skill、或 v1 的 skill 被直接改過（除非 `--discard-edits`），都在寫入前停止。
- v1 的資料夾先移到 trash，安裝失敗時搬回來。
- 成功後 v1 的 registry 與 state 改名為 `*.v1` 保留；移除 npx skills 的原版時，也清掉 v1 連到它們的 link。
- manifest 已經存在時拒絕執行。

## 15. 已驗證的事實

| 事實 | 證據 |
|---|---|
| `npx skills@1.7.0` 的 `update` 用 lock 的 key 當 `--skill` 重新執行 `add`；資料夾名稱取自 frontmatter 的 `name`。所以改過名的 skill 不能留在真正的 npx skills 底下 | 讀 `dist/cli.mjs`（`updateGlobalSkills`、`sanitizeName`）；你的 lock 裡 `vercel-react-best-practices` 的 `skillPath` 是 `skills/react-best-practices` |
| shadow HOME 能隔離 `npx skills` | 2026-10-29：`HOME=<shadow>` 執行 `npx skills add mattpocock/skills -g -a codex -s tdd -y`，lock 寫進 `<shadow>/.agents/.skill-lock.json`，真正的 lock shasum 前後相同 |
| `npx skills` 的 lock 路徑只受 `XDG_STATE_HOME` 與 `HOME` 影響 | 讀 `dist/cli.mjs` 的 `getSkillLockPath` |
| `git ls-remote` 不消耗 GitHub REST 額度 | 連跑三次，`rate_limit` 的 core 剩餘量 58 → 58 |
| recursive tree 的資料夾 sha 等於 `skillFolderHash` | `skills/engineering/tdd` 兩者都是 `667dbdd00c09d0e2189e082986e6a4d61a67c2a6` |
| 沒有 ref 時，npx skills 對 `BLOB_ALLOWED_OWNERS`（vercel、vercel-labs、heygen-com、remotion-dev）改從 skills.sh 下載快照；給了 ref 就走 `cloneRepo`，commit sha 由 `cloneAtSha` 處理 | 讀 `dist/cli.mjs`（`tryBlobInstall`、`cloneRepo`）；`vercel-labs/agent-skills` 不指定 ref 時，`vercel-optimize` 的 7 個 100755 檔案都變成 100644 |
| `name` 只能小寫英數與單一連字號、最多 64 字元、必須和資料夾相同 | agentskills.io/specification |
| Node 無法直接執行 `.tsx` | Node 26.13.0 對 `.tsx` 報語法錯誤，所以 TUI 不用 JSX |

待驗證（在對應的 Phase 證明）：Ink 在 TUI 把終端機交給互動 installer、再拿回來時是否正常（P10）。

## 16. 決定紀錄

| # | 決定 | 理由 | 日期 |
|---|---|---|---|
| 1 | 身分是 `來源/原名`，安裝名稱由規則算出 | 改名不影響更新追蹤與 patch | 2026-10-29 |
| 2 | 前綴預設開啟，預設值是來源 id | 看名稱就知道來源，跨來源撞名基本消失 | 2026-10-29 |
| 3 | 前綴只用 `-` | Agent Skills 規格只允許這個分隔 | 2026-10-29 |
| 4 | 不做 Claude Code plugin 的冒號命名 | 只有 Claude Code 看得到，目標是所有 agent | 2026-10-29 |
| 5 | GitHub 來源用 `npx skills` 在 shadow HOME 下載 | 探索 skill 的規則和你平常用的一致，又不動到真正的 lock | 2026-10-29 |
| 6 | 撞名不做互動選單，停下並說明 | 預設前綴後撞名很少，錯誤訊息比選單簡單 | 2026-10-29 |
| 7 | 自訂前綴不能重複 | 讓「兩個來源同前綴」在讀 manifest 時就被擋下 | 2026-10-29 |
| 8 | 客製化存成對原名版本的 patch，更新時三方合併 | 改前綴不影響 patch；只給兩份檔案無法分辨誰改了什麼 | 2026-10-29 |
| 9 | 介面一律英文 | 你的偏好 | 2026-10-29 |
| 10 | 不保留 v1 相容層，一次性遷移後刪除 | 避免長期維護兩套資料格式 | 2026-10-29 |
| 11 | 不開 PR，每個 Phase 在 `main` 上驗證後 commit | 個人專案，流程從簡 | 2026-10-29 |
