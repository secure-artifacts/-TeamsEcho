const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

let mainWindow;
let safetyWindow;
let isStopping = false;
let isPausedForForeground = false;
let currentAutomationData = null;

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

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
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
      exec(`osascript -e '${script}'`, (err, stdout) => {
        resolve(err ? '' : stdout.trim());
      });
    } else {
      const psCommand = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32 {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
          }
"@;
        $h = [Win32]::GetForegroundWindow();
        $sb = New-Object System.Text.StringBuilder 256;
        [Win32]::GetWindowText($h, $sb, 256) | Out-Null;
        $pid = 0;
        [Win32]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null;
        $p = Get-Process -Id $pid -ErrorAction SilentlyContinue;
        if ($p) { $p.ProcessName + "||" + $sb.ToString() } else { "||" + $sb.ToString() }
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, ' ')}"`, (err, stdout) => {
        resolve(err ? '' : stdout.trim());
      });
    }
  });
}

// 网页版 + 客户端多维立体白名单放行校验（含 Teams 标记则判定安全）
function isForegroundTeams(rawInfo) {
  if (!rawInfo) return false;
  return /teams/i.test(rawInfo);
}

// 精确窗口定位与激活（基于句柄与特定窗体升维，终结多浏览器窗口乱跳）
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
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, () => resolve());
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

      const psCommand = `
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
"@;
        $excludeArr = @(${formattedExclude});
        $hwnd = [WinFinder]::Find("${targetProc}", "teams", $excludeArr);
        if ($hwnd -ne [IntPtr]::Zero) {
          [WinFinder]::Activate($hwnd) | Out-Null;
        } else {
          $w = New-Object -ComObject Wscript.Shell;
          [void]$w.AppActivate('Teams');
        }
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, ' ')}"`, () => resolve());
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

function runPlatformKeystrokeForPerson(name, speedLevel) {
  return new Promise(async (resolve) => {
    clipboard.writeText(name);

    const d60 = getScaledDelay(60, speedLevel) / 1000;
    const d150 = getScaledDelay(150, speedLevel) / 1000;
    const d180 = getScaledDelay(180, speedLevel) / 1000;

    const win60 = getScaledDelay(60, speedLevel);
    const win150 = getScaledDelay(150, speedLevel);
    const win180 = getScaledDelay(180, speedLevel);

    const rawInfo = await getFrontmostAppName();

    if (process.platform === 'darwin') {
      const script = `
        delay ${d60}
        tell application "System Events"
          keystroke "@"
          delay ${d60}
          key code 123
          delay ${d60}
          keystroke "v" using command down
          delay ${d150}
          keystroke "1"
          delay ${d60}
          key code 51
          delay ${d180}
          key code 36
          delay ${d60}
        end tell
      `;
      await activateTargetTarget(rawInfo);
      exec(`osascript -e '${script}'`, () => resolve());
    } else {
      const psCommand = `
        $wshell = New-Object -ComObject Wscript.Shell;
        Start-Sleep -m ${win60};
        $wshell.SendKeys("@");
        Start-Sleep -m ${win60};
        $wshell.SendKeys("{LEFT}");
        Start-Sleep -m ${win60};
        $wshell.SendKeys("^v");
        Start-Sleep -m ${win150};
        $wshell.SendKeys("1");
        Start-Sleep -m ${win60};
        $wshell.SendKeys("{BACKSPACE}");
        Start-Sleep -m ${win180};
        $wshell.SendKeys("{ENTER}");
      `;
      await activateTargetTarget(rawInfo);
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`, () => resolve());
    }
  });
}

function pasteRichContent(speedLevel) {
  return new Promise(async (resolve) => {
    const d150 = getScaledDelay(150, speedLevel) / 1000;
    const win150 = getScaledDelay(150, speedLevel);
    const rawInfo = await getFrontmostAppName();

    if (process.platform === 'darwin') {
      const script = `
        delay ${d150}
        tell application "System Events" to keystroke "v" using command down
      `;
      await activateTargetTarget(rawInfo);
      exec(`osascript -e '${script}'`, () => resolve());
    } else {
      const psCommand = `
        $w = New-Object -ComObject Wscript.Shell;
        Start-Sleep -m ${win150};
        $w.SendKeys('^v')
      `;
      await activateTargetTarget(rawInfo);
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`, () => resolve());
    }
  });
}

function safeLineBreak(speedLevel) {
  return new Promise(async (resolve) => {
    const d100 = getScaledDelay(100, speedLevel) / 1000;
    const win100 = getScaledDelay(100, speedLevel);
    const rawInfo = await getFrontmostAppName();

    if (process.platform === 'darwin') {
      const script = `
        delay ${d100}
        tell application "System Events" to keystroke return using shift down
      `;
      await activateTargetTarget(rawInfo);
      exec(`osascript -e '${script}'`, () => resolve());
    } else {
      const psCommand = `
        $w = New-Object -ComObject Wscript.Shell;
        Start-Sleep -m ${win100};
        $w.SendKeys('+{ENTER}')
      `;
      await activateTargetTarget(rawInfo);
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`, () => resolve());
    }
  });
}

ipcMain.on('trigger-safety-check', async (event, data) => {
  currentAutomationData = data;
  const rawInfo = await getFrontmostAppName();
  await activateTargetTarget(rawInfo);

  if (safetyWindow) { safetyWindow.focus(); return; }

  safetyWindow = new BrowserWindow({
    width: 560,
    height: 410,
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
  safetyWindow.on('closed', () => { safetyWindow = null; });
});

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
      exec(`osascript -e 'delay ${d80}\ntell application "System Events" to keystroke "x" using {command down, shift down}'`);
    } else {
      await activateTargetTarget(rawInfo);
      exec(`powershell -Command "$w = New-Object -ComObject Wscript.Shell; Start-Sleep -m ${win80}; $w.SendKeys('^+x')"`);
    }
    return;
  }

  if (responseType === 'confirm') {
    if (safetyWindow) safetyWindow.close();
    if (!currentAutomationData) return;

    const { names, htmlContent, textContent, sequenceMode, speedLevel } = currentAutomationData;
    const currentLevel = speedLevel || 5;
    isStopping = false;
    const originalClipboard = clipboard.readText();

    mainWindow.webContents.send('status-update', '🚀 自动化开始执行...');

    const runMentionPass = async () => {
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        const ok = await ensureForegroundOrPause();
        if (!ok) break;
        mainWindow.webContents.send('status-update', `📈 正在粘贴提及：${names[i]} (${i + 1}/${names.length})`);
        await runPlatformKeystrokeForPerson(names[i], currentLevel);
      }
    };

    const hasContent = !!(textContent && textContent.trim().length > 0);
    const postBreakWait = getScaledDelay(150, currentLevel);

    if (sequenceMode === 'mentionFirst') {
      await runMentionPass();
      if (!isStopping && hasContent) {
        const ok = await ensureForegroundOrPause();
        if (ok) {
          await safeLineBreak(currentLevel);
          await new Promise(res => setTimeout(res, postBreakWait));
          const okBeforePaste = await ensureForegroundOrPause();
          if (okBeforePaste) {
            clipboard.write({ html: htmlContent, text: textContent });
            await pasteRichContent(currentLevel);
          }
        }
      }
    } else {
      if (hasContent) {
        mainWindow.webContents.send('status-update', '🔗 正在注入消息正文内容...');
        const okBeforeBody = await ensureForegroundOrPause();
        if (okBeforeBody) {
          clipboard.write({ html: htmlContent, text: textContent });
          await pasteRichContent(currentLevel);

          const okBeforeBreak = await ensureForegroundOrPause();
          if (okBeforeBreak) {
            await safeLineBreak(currentLevel);
            await new Promise(res => setTimeout(res, postBreakWait));
            await runMentionPass();
          }
        }
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

    // 内存安全纵深防御：结束时立刻在内存中物理清空任务数据，防扫描留痕
    currentAutomationData = null;

    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  }
});

ipcMain.on('stop-automation', () => {
  isStopping = true;
  if (isPausedForForeground) {
    ipcMain.emit('resume-after-foreground-lost');
  }
});