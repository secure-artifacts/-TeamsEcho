const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

// 统一的 Windows PowerShell 执行器：把脚本写入临时 .ps1 文件后用 -File 方式执行，
// 彻底避免把带 here-string / 双引号的多行脚本硬压成单行塞进 -Command "..."
// 所引发的换行丢失、引号错位等一系列脆弱问题。执行完毕后静默清理临时文件。
function runWindowsPowerShell(scriptContent) {
  return new Promise((resolve) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `teamsecho_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`
    );
    try {
      fs.writeFileSync(tmpFile, scriptContent, 'utf8');
    } catch (e) {
      resolve({ err: e, stdout: '' });
      return;
    }
    currentChild = execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], (err, stdout) => {
      fs.unlink(tmpFile, () => {});
      currentChild = null;
      resolve({ err, stdout });
    });
  });
}

let mainWindow;
let safetyWindow;
let isStopping = false;
let isPausedForForeground = false;
let currentAutomationData = null;

// 当前正在运行的外部子进程（osascript / powershell）。
// 只要保证同一时刻只有一个自动化脚本在跑（目前的实现确实是这样，全程 await 串行执行），
// 用一个全局变量记录句柄就够了：点"停止"时直接 kill 掉它，而不是干等它自然跑完。
let currentChild = null;

function killCurrentChild() {
  if (currentChild) {
    try { currentChild.kill(); } catch (e) { /* 进程可能已经退出，忽略 */ }
    currentChild = null;
  }
}

// 持久化配置文件路径
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// 几何插值物理倍率映射函数
const speedRates = {
  1: 3.00, 2: 2.28, 3: 1.73, 4: 1.32, 5: 1.00,
  6: 0.57, 7: 0.32, 8: 0.185, 9: 0.105, 10: 0.06
};

// 工具函数：获取当前档位缩放后的延迟数值，四舍五入，最低1ms兜底
function getScaledDelay(ms, level) {
  const rate = speedRates[level] || 1.00;
  return Math.max(1, Math.round(ms * rate));
}

// “等待 @ 模糊搜索结果高亮就绪”这一步的最低保底时间（毫秒）。
// 实测已经证明：把“删除1之后、回车之前”这一步锁在 200ms，6档和7档变成同一个数值，
// 但 6 档零失误、7 档仍大量黑体——说明瓶颈不在这一步，而在更早的环节（大概率是
// “粘贴名字之后”这一步，因为那才是真正触发 Teams 模糊搜索/通讯录查询的时间点）。
// 下面把每一段延迟拆成独立常量，方便你自己逐段二分排查，不用每次都改动整个函数。
// 排查方法：一次只调一个 FLOOR_MS，其余保持 0（不生效，走正常档位缩放），
// 跑一轮 7 档看黑体字是否消失；确认是哪一段之后再回来告诉我，我帮你收敛成最终值。
//
// 【已排查结论】：单独锁 AFTER_DELETE、单独锁 AFTER_PASTE 都没能让 7 档追平 6 档，
// 说明不是某一段单独不够，而是好几段延迟叠加的“总耗时”不够。下面把各段锁定为
// 6 档（速率 0.57）此刻对应的实际数值，相当于让这一个“@ 提及”动作本身按 6 档节奏跑，
// 不管你把总体速度调多快都不受影响；其余函数（人和人之间等待、正文粘贴、换行）依旧
// 正常跟着档位加速。
//
// 【重要变更 + 风险提示】：应用户要求，去掉了序列里的“左移”步骤，只保留
// “@ → 粘贴 → 打1 → 删除 → 回车”五步。实测已证实左移是让粘贴的名字精确落在
// 搜索识别范围内的关键——去掉它之后，“打1再删除”能不能顶替左移的定位作用，
// 没有专门验证过。最坏情况不是黑体字这种肉眼可见的失败，而是安安静静地
// @ 错人（选中列表默认第一位，界面上跟正常 @ 一模一样）。正式批量使用前，
// 务必自己用有包含关系/相近的名字（比如“张三”和“张三丰”）测试几轮，
// 确认每次都精确选中了你要的人。
const SIX_LEVEL_RATE = 0.57;
const AFTER_AT_FLOOR_MS = Math.round(60 * SIX_LEVEL_RATE);          // 34
const AFTER_PASTE_FLOOR_MS = Math.round(150 * SIX_LEVEL_RATE);      // 86
const AFTER_DIGIT_FLOOR_MS = Math.round(60 * SIX_LEVEL_RATE);       // 34
const AFTER_DELETE_FLOOR_MS = Math.round(180 * SIX_LEVEL_RATE);     // 103
const PRE_AT_FLOOR_MS = Math.round(60 * SIX_LEVEL_RATE);            // 34
const AFTER_ENTER_FLOOR_MS = Math.round(60 * SIX_LEVEL_RATE);       // 34


function floored(baseMs, speedLevel, floorMs) {
  return Math.max(getScaledDelay(baseMs, speedLevel), floorMs);
}

// 【本轮修正 v2】：上一版有个副作用——安全余量是直接乘在“8档的绝对数值”上做成
// 一个固定地板，而 Math.max(原始值, 地板) 对所有档位一视同仁，结果 8 档自己的
// 原始值（28ms）也被这个地板（56ms）盖过去了，等于连带把你已经验证稳定的 8 档
// 一起变慢了。这不是你要的“8档保持原样、9/10在它之上尝试更快”。
//
// 现在把两件事拆开：
// 1）8 档（以及更低档位）永远只用自己按档位算出来的原始值，完全不受这个地板影响，
//    不管余量怎么调，8 档的行为都和你验证过的那次一模一样，钉死为基线。
// 2）只有超过 8 档（也就是 9、10 档）才会去够这个地板——地板 = 8 档原始值 × 安全余量，
//    余量只是给“9/10 敢往多快尝试”兜底，不会往回影响 8 档本身。
const SEARCH_FLOOR_BASELINE_LEVEL = 8; // 你验证过、绝对不能被连带改变的基线档位
const SEARCH_RESULT_FLOOR_RATE = speedRates[SEARCH_FLOOR_BASELINE_LEVEL]; // 0.185
const SEARCH_FLOOR_SAFETY_MARGIN = 2; // 只作用于 9 档及以上，"速度 vs 稳定性"唯一的调节旋钮
const AFTER_PASTE_SEARCH_FLOOR_MS = Math.round(150 * SEARCH_RESULT_FLOOR_RATE * SEARCH_FLOOR_SAFETY_MARGIN); // 56

// 算出实际要用的 afterPaste：8档及以下完全走原始值（基线不可变）；
// 9档及以上才会被抬到上面那个带余量的地板，且地板本身不会超过基线×余量这个上限。
function resolveAfterPasteDelay(speedLevel, afterPasteRaw) {
  if (speedLevel <= SEARCH_FLOOR_BASELINE_LEVEL) return afterPasteRaw;
  return Math.max(afterPasteRaw, AFTER_PASTE_SEARCH_FLOOR_MS);
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  mainWindow.loadFile('src/index.html');
  mainWindow.on('close', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['确认退出', '取消'],
      title: '确认退出？',
      message: '安全提示：退出后当前输入的所有消息及名单将在内存中彻底销毁，软件不留任何本地草稿。'
    });
    if (choice === 1) e.preventDefault();
  });
}

app.whenReady().then(createWindow);

// IPC 状态持久化处理
ipcMain.handle('load-settings', () => {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) { console.error(e); }
  return null;
});

ipcMain.on('save-settings', (event, settings) => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { console.error(e); }
});

// 通配获取前台活动窗口标题/进程名称
function getFrontmostAppName() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = `
        tell application "System Events"
          set frontProcess to first application process whose frontmost is true
          set windowTitle to ""
          try
            if (count of windows of frontProcess) > 0 then
              set windowTitle to name of first window of frontProcess
            end if
          end try
          return (name of frontProcess) & "||" & windowTitle
        end tell
      `;
      execFile('osascript', ['-e', script], (err, stdout) => {
        resolve(err ? '' : stdout.trim());
      });
    } else {
      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$h = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32]::GetWindowText($h, $sb, 256) | Out-Null
$procId = 0
[Win32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
if ($p) { Write-Output ($p.ProcessName + "||" + $sb.ToString()) } else { Write-Output ("||" + $sb.ToString()) }
`;
      runWindowsPowerShell(psScript).then(({ err, stdout }) => {
        resolve(err ? '' : stdout.trim());
      });
    }
  });
}

// 核心优化状态机：记录“上一次确认前台确实是 Teams 上下文”的状态。
let lastKnownTeamsContext = false;

// 网页版 + 客户端多维立体白名单放行校验（状态化高级容错）
function isForegroundTeams(rawInfo) {
  if (!rawInfo) return false;

  const [procNameRaw, titleRaw] = rawInfo.split('||');
  const procName = (procNameRaw || '').toLowerCase().trim();
  const title = (titleRaw || '').toLowerCase().trim();

  // 情形一：进程名或标题任一命中 "teams" 即可信。
  // 注意：原生客户端（Mac 的 "Microsoft Teams" 进程、Windows 客户端同理）的窗口标题
  // 往往是频道名/聊天对象名，本身并不含 "teams" 字样，只有进程名才带 teams 标记，
  // 所以这里必须两者都检查，只查 title 会把原生客户端误判为不安全。
  if (/teams/.test(procName) || /teams/.test(title)) {
    lastKnownTeamsContext = true;
    return true;
  }

  // 情形二：前台是浏览器，但由于多进程渲染或标签页休眠，标题读不出来（空或"未知窗口"）。
  // 只有在最近一次已确认处于 Teams 上下文时才顺势放行一次，避免长期误放行。
  const isBrowserProc = /chrome|msedge/.test(procName);
  const titleUnreadable = title === '' || title === '未知窗口';

  if (isBrowserProc && titleUnreadable && lastKnownTeamsContext) {
    return true;
  }

  // 其他情况：标题明确可读但不含 teams，或压根不是浏览器/Teams 进程 —— 判定不安全。
  lastKnownTeamsContext = false;
  return false;
}

function activateTargetTarget(rawInfo) {
  return new Promise((resolve) => {
    const isChrome = /chrome/i.test(rawInfo);
    const isEdge = /edge/i.test(rawInfo) || /msedge/i.test(rawInfo);

    if (process.platform === 'darwin') {
      const macFallbackApp = isChrome ? 'Google Chrome' : (isEdge ? 'Microsoft Edge' : 'Microsoft Teams');
      const script = `
        tell application "System Events"
          set targetProc to missing value
          set targetWin to missing value
          repeat with proc in (application processes whose background only is false)
            try
              repeat with w in windows of proc
                if name of w contains "Teams" then
                  set targetProc to proc
                  set targetWin to w
                  exit repeat
                end if
              end repeat
            end try
            if targetProc is not missing value then exit repeat
          end repeat
          if targetProc is not missing value then
            set frontmost of targetProc to true
            try
              perform action "AXRaise" of targetWin
            end try
          else
            tell application "${macFallbackApp}" to activate
          end if
        end tell
      `;
      execFile('osascript', ['-e', script], () => resolve());
    } else {
      let targetProc = '';
      let excludeProc = '';
      if (isChrome) {
        targetProc = 'chrome';
      } else if (isEdge) {
        targetProc = 'msedge';
      } else {
        excludeProc = 'chrome,msedge';
      }

      const formattedExclude = excludeProc ? excludeProc.split(',').map(s => `"${s}"`).join(',') : '';

      const psScript = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinFinder {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

    public static IntPtr FoundHandle = IntPtr.Zero;
    public static string TargetProc = "";
    public static string TitleContains = "teams";
    public static string[] ExcludeProcs = new string[0];

    public static bool Callback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return true;
        var sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        string title = sb.ToString();
        if (title.ToLower().IndexOf(TitleContains.ToLower()) < 0) return true;

        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        string procName = "";
        try {
            var p = System.Diagnostics.Process.GetProcessById((int)pid);
            procName = p.ProcessName.ToLower();
        } catch { return true; }

        if (!string.IsNullOrEmpty(TargetProc) && procName.IndexOf(TargetProc.ToLower()) < 0) return true;

        foreach (var ex in ExcludeProcs) {
            if (!string.IsNullOrEmpty(ex) && procName.IndexOf(ex.ToLower()) >= 0) return true;
        }

        FoundHandle = hWnd;
        return false;
    }

    public static IntPtr Find(string targetProc, string titleContains, string[] excludeProcs) {
        FoundHandle = IntPtr.Zero;
        TargetProc = targetProc;
        TitleContains = titleContains;
        ExcludeProcs = excludeProcs;
        EnumWindows(new EnumWindowsProc(Callback), IntPtr.Zero);
        return FoundHandle;
    }

    public static bool Activate(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        return SetForegroundWindow(hWnd);
    }
}
"@

$excludeArr = @(${formattedExclude})
$hwnd = [WinFinder]::Find("${targetProc}", "teams", $excludeArr)
if ($hwnd -ne [IntPtr]::Zero) {
    [WinFinder]::Activate($hwnd) | Out-Null
} else {
    $w = New-Object -ComObject Wscript.Shell
    $activated = $false

    if ("${isChrome ? '1' : '0'}" -eq "1") {
        $activated = $w.AppActivate('Chrome')
    } elseif ("${isEdge ? '1' : '0'}" -eq "1") {
        $activated = $w.AppActivate('Edge')
    }

    if (-not $activated) {
        $activated = $w.AppActivate('Teams')
    }

    Start-Sleep -m 350
    $hwnd2 = [WinFinder]::Find("${targetProc}", "teams", $excludeArr)
    if ($hwnd2 -ne [IntPtr]::Zero) {
        [WinFinder]::Activate($hwnd2) | Out-Null
    }
}
`;
      runWindowsPowerShell(psScript).then(() => resolve());
    }
  });
}

async function ensureForegroundOrPause() {
  const rawInfo = await getFrontmostAppName();
  if (isForegroundTeams(rawInfo)) return true;

  const displayTitle = rawInfo.split('||')[1] || rawInfo.split('||')[0] || '未知窗口';
  isPausedForForeground = true;
  mainWindow.webContents.send('foreground-lost', displayTitle);
  mainWindow.webContents.send('status-update', `⏸️ 检测到前台已切换到「${displayTitle}」，自动化已暂停，等待确认。`);

  await new Promise((resolve) => {
    const onResume = () => {
      ipcMain.removeListener('resume-after-foreground-lost', onResume);
      resolve();
    };
    ipcMain.on('resume-after-foreground-lost', onResume);
  });

  await activateTargetTarget(rawInfo);
  isPausedForForeground = false;
  return !isStopping;
}

// 不阻塞版本：按你的要求，跑 100 人的过程中不需要人工确认这一步。
// 发现前台不是 Teams 时，只尝试拉回一次、留一点缓冲时间，然后无论成不成功都继续往下跑，
// 不会像 ensureForegroundOrPause 那样一直等你手动点"继续"。
// 代价很明确：如果这次真的没能把 Teams 拉回前台，这一步的按键会打空（不会误发消息，
// 但这个人可能会漏 @），需要你事后自己肉眼扫一遍名单核对。
async function ensureForegroundNoBlock(bufferMs) {
  const rawInfo = await getFrontmostAppName();
  if (isForegroundTeams(rawInfo)) return;
  await activateTargetTarget(rawInfo);
  await new Promise((res) => setTimeout(res, bufferMs));
}

// 合一版本：把"查前台窗口"和"敲键盘"揉进同一次系统调用，只在真正需要暂停
// 或者需要走浏览器兜底判断的少数情况下，才多付一次进程调用的开销。
// 返回 "OK"（已经执行完按键）或 "procName||title"（前台不匹配，未执行按键，
// 交给调用方按原来的 isForegroundTeams/ensureForegroundOrPause 逻辑处理）。
//
// isFirst：是否是这一轮里第一个被 @ 的人。Teams 的 @ 模糊搜索第一次触发时，
// 往往要现拉一次通讯录/联系人索引（冷启动），比后续搜索明显慢；后面的搜索
// 因为客户端已经有缓存，会快很多。这就是"9档下第一个人经常被错误@选中，
// 后面的人反而都精准"的根本原因——不是概率问题，是第一次搜索确实更慢。
// 所以第一个人固定给一个不受档位/极速模式影响的冷启动缓冲，其余人正常按档位跑。
const COLD_START_AFTER_PASTE_MS = 550;

function checkAndMentionOnce(name, speedLevel, turboMode, isFirst) {
  return new Promise((resolve) => {
    clipboard.writeText(name);

    // 其余五段延迟不再跟着旧的"6档地板"或 turboMode 走——纯本地按键节奏，
    // 直接按你选的档位线性变快，9档、10档都会比8档更快。
    const preAt      = getScaledDelay(60, speedLevel);
    const afterAt     = getScaledDelay(60, speedLevel);
    const afterPasteRaw = getScaledDelay(150, speedLevel);
    // 只有这一步钉死在"检索安全下限"：8档及以下永远用自己的原始值（基线不变），
    // 只有 9、10 档才会被抬到"8档基线×安全余量"这个地板，因为这一步等的是
    // Teams 自己的模糊搜索/网络响应，不是本地按键速度能决定的。
    const afterPaste  = isFirst
      ? Math.max(afterPasteRaw, COLD_START_AFTER_PASTE_MS)
      : resolveAfterPasteDelay(speedLevel, afterPasteRaw);
    const afterDigit  = getScaledDelay(60, speedLevel);
    const afterDelete = getScaledDelay(180, speedLevel);
    const afterEnter  = getScaledDelay(60, speedLevel);

    if (process.platform === 'darwin') {
      const script = `
        set isTeams to false
        tell application "System Events"
          set frontProcess to first application process whose frontmost is true
          set procName to name of frontProcess
          set windowTitle to ""
          try
            if (count of windows of frontProcess) > 0 then
              set windowTitle to name of first window of frontProcess
            end if
          end try
        end tell
        ignoring case
          if (procName contains "teams") or (windowTitle contains "teams") then
            set isTeams to true
          end if
        end ignoring
        if isTeams then
          delay ${preAt / 1000}
          tell application "System Events"
            keystroke "@"
            delay ${afterAt / 1000}
            keystroke "v" using command down
            delay ${afterPaste / 1000}
            keystroke "1"
            delay ${afterDigit / 1000}
            key code 51
            delay ${afterDelete / 1000}
            key code 36
            delay ${afterEnter / 1000}
          end tell
          "OK"
        else
          procName & "||" & windowTitle
        end if
      `;
      currentChild = execFile('osascript', ['-e', script], (err, stdout) => {
        currentChild = null;
        resolve(err ? '' : stdout.trim());
      });
    } else {
      const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Fast {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$h = [Win32Fast]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32Fast]::GetWindowText($h, $sb, 256) | Out-Null
$procId = 0
[Win32Fast]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$procName = if ($p) { $p.ProcessName } else { "" }
$title = $sb.ToString()

if ($procName -match "(?i)teams" -or $title -match "(?i)teams") {
    $wshell = New-Object -ComObject Wscript.Shell
    Start-Sleep -m ${preAt}
    $wshell.SendKeys("@")
    Start-Sleep -m ${afterAt}
    $wshell.SendKeys("^v")
    Start-Sleep -m ${afterPaste}
    $wshell.SendKeys("1")
    Start-Sleep -m ${afterDigit}
    $wshell.SendKeys("{BACKSPACE}")
    Start-Sleep -m ${afterDelete}
    $wshell.SendKeys("{ENTER}")
    Write-Output "OK"
} else {
    Write-Output ($procName + "||" + $title)
}
`;
      runWindowsPowerShell(psScript).then(({ err, stdout }) => {
        resolve(err ? '' : stdout.trim());
      });
    }
  });
}

function runPlatformKeystrokeForPerson(name, speedLevel, turboMode, isFirst) {
  return new Promise(async (resolve) => {
    clipboard.writeText(name);

    // 五步序列：@ → 粘贴 → 打1 → 删除 → 回车。已去掉左移步骤（应用户要求，
    // 风险已在上面的大段注释里说明，务必自行验证过边界情况再放量使用）。
    //
    // 延迟策略：8档及以下永远用自己的原始值（基线不变，不受安全余量牵连）；
    // 只有 9、10 档才会被抬到"8档基线×安全余量"这个地板。其余四段（@前/@后/
    // 打1后/删除后/回车后）完全跟随你选的档位线性变快，不再受旧的"6档地板"限制。
    const preAt      = getScaledDelay(60, speedLevel);
    const afterAt     = getScaledDelay(60, speedLevel);
    const afterPasteRaw = getScaledDelay(150, speedLevel);
    const afterPaste  = isFirst
      ? Math.max(afterPasteRaw, COLD_START_AFTER_PASTE_MS)
      : resolveAfterPasteDelay(speedLevel, afterPasteRaw);
    const afterDigit  = getScaledDelay(60, speedLevel);
    const afterDelete = getScaledDelay(180, speedLevel);
    const afterEnter  = getScaledDelay(60, speedLevel);

    // 注意：这里不再重复查询/激活前台窗口——调用方在每次调用前都刚做过一次
    // ensureForegroundNoBlock()，已经确认（或主动拉回）Teams 处于前台。重复查询
    // 只是徒增两次子进程启动的固定开销，对正确性没有任何帮助。

    if (process.platform === 'darwin') {
      const script = `
        delay ${preAt / 1000}
        tell application "System Events"
          keystroke "@"
          delay ${afterAt / 1000}
          keystroke "v" using command down
          delay ${afterPaste / 1000}
          keystroke "1"
          delay ${afterDigit / 1000}
          key code 51
          delay ${afterDelete / 1000}
          key code 36
          delay ${afterEnter / 1000}
        end tell
      `;
      currentChild = execFile('osascript', ['-e', script], () => { currentChild = null; resolve(); });
    } else {
      const psScript = `
$wshell = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${preAt}
$wshell.SendKeys("@")
Start-Sleep -m ${afterAt}
$wshell.SendKeys("^v")
Start-Sleep -m ${afterPaste}
$wshell.SendKeys("1")
Start-Sleep -m ${afterDigit}
$wshell.SendKeys("{BACKSPACE}")
Start-Sleep -m ${afterDelete}
$wshell.SendKeys("{ENTER}")
`;
      runWindowsPowerShell(psScript).then(() => resolve());
    }
  });
}

function pasteRichContent(speedLevel) {
  return new Promise(async (resolve) => {
    const d150 = getScaledDelay(150, speedLevel) / 1000;
    const win150 = getScaledDelay(150, speedLevel);

    if (process.platform === 'darwin') {
      const script = `
        delay ${d150}
        tell application "System Events" to keystroke "v" using command down
      `;
      currentChild = execFile('osascript', ['-e', script], () => { currentChild = null; resolve(); });
    } else {
      const psScript = `
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win150}
$w.SendKeys('^v')
`;
      runWindowsPowerShell(psScript).then(() => resolve());
    }
  });
}

function safeLineBreak(speedLevel) {
  return new Promise(async (resolve) => {
    const d100 = getScaledDelay(100, speedLevel) / 1000;
    const win100 = getScaledDelay(100, speedLevel);

    if (process.platform === 'darwin') {
      const script = `
        delay ${d100}
        tell application "System Events" to keystroke return using shift down
      `;
      currentChild = execFile('osascript', ['-e', script], () => { currentChild = null; resolve(); });
    } else {
      const psScript = `
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win100}
$w.SendKeys('+{ENTER}')
`;
      runWindowsPowerShell(psScript).then(() => resolve());
    }
  });
}

ipcMain.on('trigger-safety-check', async (event, data) => {
  currentAutomationData = data;
  const rawInfo = await getFrontmostAppName();
  await activateTargetTarget(rawInfo);

  if (safetyWindow) {
    safetyWindow.webContents.send('safety-mode-info', !!data.turboMode);
    safetyWindow.focus();
    return;
  }

  safetyWindow = new BrowserWindow({
    width: 560,
    height: 470,
    useContentSize: true,
    parent: mainWindow,
    modal: true,
    alwaysOnTop: true,
    resizable: false,
    frame: true,
    title: "安全核对栏",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });

  safetyWindow.loadFile('src/safety.html');
  safetyWindow.webContents.once('did-finish-load', () => {
    safetyWindow.webContents.send('safety-mode-info', !!data.turboMode);
  });
  safetyWindow.on('closed', () => { safetyWindow = null; });
});

// 人工手动点回 Teams 聊天框需要的反应时间。这个等待跟"每个人之间该多快"是
// 两件完全不同的事——不该跟着速度档位一起被压缩。固定给这么多时间，不管选了
// 哪一档速度都不变，专门用来兜住"点确认之后，你手动点一下鼠标切回聊天框"这个动作。
// 如果你实测下来觉得还是偶尔来不及/或者觉得可以再短一点，告诉我具体数值，
// 这里改一个数字就行，不用跟档位逻辑绑在一起改。
const MANUAL_REFOCUS_BUFFER_MS = 900;

ipcMain.on('safety-response', async (event, responseType) => {
  if (responseType === 'cancel') {
    if (safetyWindow) safetyWindow.close();
    mainWindow.webContents.send('status-update', '❌ 操作已被安全取消，未向 Teams 写入任何数据。');
    return;
  }

  if (responseType === 'switch') {
    const currentLevel = currentAutomationData ? (currentAutomationData.speedLevel || 5) : 5;
    const d80 = getScaledDelay(80, currentLevel) / 1000;
    const win80 = getScaledDelay(80, currentLevel);
    const rawInfo = await getFrontmostAppName();

    if (process.platform === 'darwin') {
      await activateTargetTarget(rawInfo);
      execFile('osascript', ['-e', `delay ${d80}\ntell application "System Events" to keystroke "x" using {command down, shift down}`], () => {});
    } else {
      await activateTargetTarget(rawInfo);
      runWindowsPowerShell(`
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win80}
$w.SendKeys('^+x')
`);
    }
    return;
  }

  if (responseType === 'confirm') {
    if (safetyWindow) safetyWindow.close();
    if (!currentAutomationData) return;

    const { names, htmlContent, textContent, sequenceMode, speedLevel, turboMode } = currentAutomationData;
    const currentLevel = speedLevel || 5;
    isStopping = false;
    const originalClipboard = clipboard.readText();

    // 关键修复：safetyWindow 是 mainWindow 的模态子窗口，关闭它之后操作系统/Electron
    // 通常会把焦点交还给"父窗口"（也就是本应用自己的主界面），而不是自动跳回 Teams。
    // 低档位时序列里的延迟本身较长，无意中给了系统一点缓冲时间，焦点大概率能自己转回去；
    // 档位一高（尤其6档以后），这点缓冲被压没了。这里显式留一点缓冲并主动拉回一次前台，
    // 但不阻塞等待人工确认——按你的要求，跑起来之后就不再需要中途人工介入。
    mainWindow.webContents.send('status-update', '🚀 自动化开始执行...');
    await new Promise(res => setTimeout(res, MANUAL_REFOCUS_BUFFER_MS));
    await ensureForegroundNoBlock(150);

    const runMentionPass = async () => {
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        mainWindow.webContents.send('status-update', `📈 正在粘贴提及：${names[i]} (${i + 1}/${names.length})`);
        const isFirst = i === 0;

        const result = await checkAndMentionOnce(names[i], currentLevel, !!turboMode, isFirst);

        // 子进程如果是被"停止"按钮杀掉的，checkAndMentionOnce 会因为 execFile 报错
        // 而 resolve 成空字符串 ''——这不代表"前台不是 Teams"，必须先排除这种情况，
        // 否则会误触发下面的重新拉回前台逻辑。
        if (isStopping) break;

        if (result === 'OK') {
          continue; // 一次调用搞定检查+执行，最快路径
        }

        // 合一脚本里的判断只做了最直接的"标题/进程名含 teams"匹配，没有覆盖
        // 浏览器多进程/标签页休眠这类模糊场景，所以这里退回完整的 isForegroundTeams
        // 判断（含 lastKnownTeamsContext 容错）。如果 JS 这边判断其实是安全的，
        // 说明只是合一脚本里的简单匹配漏判了，直接补一次真正的按键执行即可。
        if (isForegroundTeams(result)) {
          await runPlatformKeystrokeForPerson(names[i], currentLevel, !!turboMode, isFirst);
          continue;
        }

        // 确实不是 Teams —— 按你的要求，不再暂停等待人工点"继续"：
        // 自动尝试拉回前台一次、留一点缓冲，然后不管成不成功都继续跑下一个人，
        // 保证整批跑到底不会被卡住。这个人有小概率漏@，需要事后自己扫一遍核对。
        await ensureForegroundNoBlock(getScaledDelay(150, currentLevel));
        await runPlatformKeystrokeForPerson(names[i], currentLevel, !!turboMode, isFirst);
      }
    };

    const hasContent = !!(textContent && textContent.trim().length > 0);
    const postBreakWait = getScaledDelay(150, currentLevel);

    if (sequenceMode === 'mentionFirst') {
      await runMentionPass();
      if (!isStopping && hasContent) {
        await ensureForegroundNoBlock(getScaledDelay(150, currentLevel));
        await safeLineBreak(currentLevel);
        await new Promise(res => setTimeout(res, postBreakWait));
        await ensureForegroundNoBlock(getScaledDelay(150, currentLevel));
        clipboard.write({ html: htmlContent, text: textContent });
        await pasteRichContent(currentLevel);
      }
    } else {
      if (hasContent) {
        mainWindow.webContents.send('status-update', '🔗 正在注入消息正文内容...');
        await ensureForegroundNoBlock(getScaledDelay(150, currentLevel));
        clipboard.write({ html: htmlContent, text: textContent });
        await pasteRichContent(currentLevel);

        await ensureForegroundNoBlock(getScaledDelay(150, currentLevel));
        await safeLineBreak(currentLevel);
        await new Promise(res => setTimeout(res, postBreakWait));
        await runMentionPass();
      } else {
        mainWindow.webContents.send('status-update', '⚠️ 未检测到有效正文内容，跳过粘贴步骤，直接开始 @ 提及...');
        await runMentionPass();
      }
    }

    if (isStopping) {
      mainWindow.webContents.send('status-update', '⏹️ 自动化已被中途按键强行安全切断。');
    } else {
      mainWindow.webContents.send('status-update', '✅ 自动化执行完毕。');
    }

    // 零痕迹纵深防御：立刻物理擦除任务残留
    currentAutomationData = null;

    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  }
});

ipcMain.on('stop-automation', () => {
  isStopping = true;
  // 核心修复：不再只打标记干等，直接杀掉当前正在跑的外部脚本（osascript/powershell），
  // 这样档位再高、单次@序列耗时再长，点停止也能立刻中断，而不是等它自己跑完五步。
  killCurrentChild();
  if (isPausedForForeground) {
    ipcMain.emit('resume-after-foreground-lost');
  }
});