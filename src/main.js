const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;
let safetyWindow;
let isStopping = false;
let isPausedForForeground = false;
let currentAutomationData = null;

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

function getFrontmostAppName() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = `tell application "System Events" to get name of first application process whose frontmost is true`;
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
          }
"@;
        $h = [Win32]::GetForegroundWindow();
        $sb = New-Object System.Text.StringBuilder 256;
        [Win32]::GetWindowText($h, $sb, 256) | Out-Null;
        $sb.ToString()
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, ' ')}"`, (err, stdout) => {
        resolve(err ? '' : stdout.trim());
      });
    }
  });
}

function isForegroundTeams(name) {
  if (!name) return false;
  return /teams/i.test(name);
}

async function ensureForegroundOrPause() {
  const name = await getFrontmostAppName();
  if (isForegroundTeams(name)) return true;

  isPausedForForeground = true;
  mainWindow.webContents.send('foreground-lost', name || '未知窗口');
  mainWindow.webContents.send('status-update', `⏸️ 检测到前台已切换到「${name || '未知窗口'}」，自动化已暂停，等待确认后继续。`);

  await new Promise((resolve) => {
    const onResume = () => {
      ipcMain.removeListener('resume-after-foreground-lost', onResume);
      resolve();
    };
    ipcMain.on('resume-after-foreground-lost', onResume);
  });
  isPausedForForeground = false;
  return !isStopping;
}

function runPlatformKeystrokeForPerson(name) {
  return new Promise((resolve) => {
    clipboard.writeText(name);

    if (process.platform === 'darwin') {
      const script = `
        tell application "Microsoft Teams" to activate
        delay 0.06
        tell application "System Events"
          keystroke "@"
          delay 0.06
          key code 123
          delay 0.06
          keystroke "v" using command down
          delay 0.15
          keystroke "1"
          delay 0.06
          key code 51
          delay 0.18
          key code 36
          delay 0.06
        end tell
      `;
      exec(`osascript -e '${script}'`, () => resolve());
    } else {
      const psCommand = `
        $wshell = New-Object -ComObject Wscript.Shell;
        [void]$wshell.AppActivate("Teams");
        Start-Sleep -m 60;
        $wshell.SendKeys("@");
        Start-Sleep -m 60;
        $wshell.SendKeys("{LEFT}");
        Start-Sleep -m 60;
        $wshell.SendKeys("^v");
        Start-Sleep -m 150;
        $wshell.SendKeys("1");
        Start-Sleep -m 60;
        $wshell.SendKeys("{BACKSPACE}");
        Start-Sleep -m 180;
        $wshell.SendKeys("{ENTER}");
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`, () => resolve());
    }
  });
}

function pasteRichContent() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin'
      ? `osascript -e 'tell application "System Events" to keystroke "v" using command down'`
      : `powershell -Command "$w = New-Object -ComObject Wscript.Shell; [void]$w.AppActivate('Teams'); $w.SendKeys('^v')"`;
    exec(cmd, () => resolve());
  });
}

function safeLineBreak() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin'
      ? `osascript -e 'tell application "System Events" to keystroke return using shift down'`
      : `powershell -Command "$w = New-Object -ComObject Wscript.Shell; [void]$w.AppActivate('Teams'); $w.SendKeys('+{ENTER}')"`;
    exec(cmd, () => resolve());
  });
}

ipcMain.on('trigger-safety-check', (event, data) => {
  currentAutomationData = data;

  if (process.platform === 'darwin') {
    exec('osascript -e \'tell application "Microsoft Teams" to activate\'');
  } else {
    exec('powershell -Command "$w = New-Object -ComObject Wscript.Shell; [void]$w.AppActivate(\'Teams\')"');
  }

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
    if (process.platform === 'darwin') {
      const script = `
        tell application "Microsoft Teams" to activate
        delay 0.08
        tell application "System Events"
          keystroke "x" using {command down, shift down}
        end tell
      `;
      exec(`osascript -e '${script}'`);
    } else {
      const psCommand = `
        $w = New-Object -ComObject Wscript.Shell;
        [void]$w.AppActivate('Teams');
        Start-Sleep -m 80;
        $w.SendKeys('^+x')
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`);
    }
    return;
  }

  if (responseType === 'confirm') {
    if (safetyWindow) safetyWindow.close();
    if (!currentAutomationData) return;

    const { names, htmlContent, textContent, sequenceMode } = currentAutomationData;
    isStopping = false;
    const originalClipboard = clipboard.readText();

    mainWindow.webContents.send('status-update', '🚀 自动化开始执行...');

    const runMentionPass = async () => {
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        const ok = await ensureForegroundOrPause();
        if (!ok) break;
        mainWindow.webContents.send('status-update', `📈 正在粘贴提及：${names[i]} (${i + 1}/${names.length})`);
        await runPlatformKeystrokeForPerson(names[i]);
      }
    };

    if (sequenceMode === 'mentionFirst') {
      await runMentionPass();
      if (!isStopping) {
        const ok = await ensureForegroundOrPause();
        if (ok) {
          await safeLineBreak();
          await new Promise(res => setTimeout(res, 150));
          const okBeforePaste = await ensureForegroundOrPause();
          if (okBeforePaste) {
            clipboard.write({ html: htmlContent, text: textContent });
            await pasteRichContent();
          }
        }
      }
    } else {
      mainWindow.webContents.send('status-update', '🔗 正在注入消息正文内容...');
      const okBeforeBody = await ensureForegroundOrPause();
      if (okBeforeBody) {
        clipboard.write({ html: htmlContent, text: textContent });
        await pasteRichContent();

        const okBeforeBreak = await ensureForegroundOrPause();
        if (okBeforeBreak) {
          await safeLineBreak();
          await new Promise(res => setTimeout(res, 150));
          await runMentionPass();
        }
      }
    }

    if (isStopping) {
      mainWindow.webContents.send('status-update', '⏹️ 自动化已被中途按键强行安全切断。');
    } else {
      mainWindow.webContents.send('status-update', '✅ 自动化执行完毕。');
    }
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  }
});

ipcMain.on('stop-automation', () => {
  isStopping = true;
  if (isPausedForForeground) {
    ipcMain.emit('resume-after-foreground-lost');
  }
});
