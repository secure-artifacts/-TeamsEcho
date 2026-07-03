const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;
let safetyWindow;
let isStopping = false;
let currentAutomationData = null;

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
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

// 【真实按键链模拟】Mac 与 Windows 独立分流处理器
function runPlatformKeystrokeForPerson(name) {
  return new Promise((resolve) => {
    clipboard.writeText(name);
    
    if (process.platform === 'darwin') {
      // Mac 底层 AppleScript 极速纯净动作闭环：@ -> 向左 -> 粘贴 -> 1 -> 退格 -> 回车锁定
      const script = `
        tell application "Microsoft Teams" to activate
        delay 0.04
        tell application "System Events"
          keystroke "@"
          delay 0.04
          key code 123
          delay 0.04
          keystroke "v" using command down
          delay 0.08
          keystroke "1"
          delay 0.04
          key code 51
          delay 0.18
          key code 36
          delay 0.04
        end tell
      `;
      exec(`osascript -e '${script}'`, () => resolve());
    } else {
      // Windows 底层 PowerShell Wscript.Shell 极致对齐底层按键流
      const psCommand = `
        $wshell = New-Object -ComObject Wscript.Shell;
        [void]$wshell.AppActivate("Teams");
        Start-Sleep -m 50;
        $wshell.SendKeys("@");
        Start-Sleep -m 40;
        $wshell.SendKeys("{LEFT}");
        Start-Sleep -m 40;
        $wshell.SendKeys("^v");
        Start-Sleep -m 80;
        $wshell.SendKeys("1");
        Start-Sleep -m 40;
        $wshell.SendKeys("{BACKSPACE}");
        Start-Sleep -m 150;
        $wshell.SendKeys("{ENTER}");
      `;
      exec(`powershell -Command "${psCommand.replace(/\n/g, '')}"`, () => resolve());
    }
  });
}

// 真实注入换行及最终文本
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

// 唤醒前台并接收安全审查请求
ipcMain.on('trigger-safety-check', (event, data) => {
  currentAutomationData = data;
  
  // 先把 Teams 强制推到用户眼前，供眼球物理扫描核对
  if (process.platform === 'darwin') {
    exec('osascript -e \'tell application "Microsoft Teams" to activate\'');
  } else {
    exec('powershell -Command "$w = New-Object -ComObject Wscript.Shell; [void]$w.AppActivate(\'Teams\')"');
  }

  if (safetyWindow) { safetyWindow.focus(); return; }

  // 创建一个完全独立置顶、无边框干扰、完美还原设计稿的置顶安全核对舱
  safetyWindow = new BrowserWindow({
    width: 580,
    height: 320,
    parent: mainWindow,
    modal: true,
    alwaysOnTop: true,
    resizable: false,
    frame: true,
    title: "安全核对栏",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  safetyWindow.loadFile('src/safety.html');
  safetyWindow.on('closed', () => { safetyWindow = null; });
});

// 处理三大功能按键的真实业务闭环
ipcMain.on('safety-response', async (event, responseType) => {
  if (responseType === 'cancel') {
    if (safetyWindow) safetyWindow.close();
    mainWindow.webContents.send('status-update', '❌ 操作已被安全取消，未向 Teams 写入任何数据。');
    return;
  }

  if (responseType === 'switch') {
    // 真实盲切功能触发（跨平台适配：Mac 为 Cmd+Shift+X，Windows 为 Ctrl+Shift+X）
    if (process.platform === 'darwin') {
      exec(`osascript -e 'tell application "System Events" to keystroke "x" using {command down, shift down}'`);
    } else {
      exec(`powershell -Command "$w = New-Object -ComObject Wscript.Shell; [void]$w.AppActivate('Teams'); $w.SendKeys('^+X')"`);
    }
    // 弹窗本身雷打不动，保持锁定，静待用户二次复核
    return;
  }

  if (responseType === 'confirm') {
    // 真实全速发射功能触发
    if (safetyWindow) safetyWindow.close();
    if (!currentAutomationData) return;

    const { names, htmlContent, textContent, sequenceMode } = currentAutomationData;
    isStopping = false;
    const originalClipboard = clipboard.readText();

    mainWindow.webContents.send('status-update', '🚀 轰鸣！自动化全速发射，动作链正在无缝滚动注入...');

    if (sequenceMode === 'mentionFirst') {
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        mainWindow.webContents.send('status-update', `📈 [极速版] 正在连续粘贴提及：${names[i]} (${i+1}/${names.length})`);
        await runPlatformKeystrokeForPerson(names[i]);
      }
      if (!isStopping) {
        await safeLineBreak();
        await new Promise(res => setTimeout(res, 100));
        clipboard.write({ html: htmlContent, text: textContent });
        await pasteRichContent();
      }
    } else {
      mainWindow.webContents.send('status-update', '🔗 正在首发注入消息正文内容...');
      clipboard.write({ html: htmlContent, text: textContent });
      await pasteRichContent();
      
      await safeLineBreak();
      await new Promise(res => setTimeout(res, 100));

      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        mainWindow.webContents.send('status-update', `📈 [极速版] 正在追加粘贴提及：${names[i]} (${i+1}/${names.length})`);
        await runPlatformKeystrokeForPerson(names[i]);
      }
    }

    if (isStopping) {
      mainWindow.webContents.send('status-update', '⏹️ 自动化已被中途按键强行安全切断。');
    } else {
      mainWindow.webContents.send('status-update', '✅ 极速全自动注入已完美交付！');
    }
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  }
});

ipcMain.on('stop-automation', () => { isStopping = true; });
