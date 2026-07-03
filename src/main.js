const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;
let isStopping = false;

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
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
    if (choice === 1) {
      e.preventDefault();
    }
  });
}

app.whenReady().then(createWindow);

function runAppleScriptForPerson(name) {
  return new Promise((resolve) => {
    clipboard.writeText(name);
    const script = `
      tell application "Microsoft Teams" to activate
      delay 0.05
      tell application "System Events"
        keystroke "@"
        delay 0.05
        key code 123
        delay 0.05
        keystroke "v" using command down
        delay 0.1
        keystroke "1"
        delay 0.05
        key code 51
        delay 0.2
        key code 36
        delay 0.05
      end tell
    `;
    exec(`osascript -e '${script}'`, (err) => { resolve(err ? false : true); });
  });
}

function pasteRichContent(html, text) {
  return new Promise((resolve) => {
    clipboard.write({ html: html, text: text });
    const script = `
      tell application "Microsoft Teams" to activate
      delay 0.1
      tell application "System Events"
        keystroke "v" using command down
        delay 0.1
      end tell
    `;
    exec(`osascript -e '${script}'`, () => { resolve(); });
  });
}

ipcMain.on('start-automation', async (event, data) => {
  const { names, htmlContent, textContent, sequenceMode } = data;
  isStopping = false;
  const originalClipboard = clipboard.readText();

  exec('osascript -e \'tell application "Microsoft Teams" to activate\'', async (err) => {
    if (err) {
      event.reply('status-update', '❌ 错误: 未能在系统中检测到 Microsoft Teams 客户端！');
      return;
    }

    event.reply('status-update', '🛡️ 安全锁机制：正在强制 Teams 锁死在富文本编辑状态...');
    clipboard.write({ html: '<div style="display:inline-block;"></div>' });
    await new Promise((res) => {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, () => res());
    });
    await new Promise(res => setTimeout(res, 300));

    if (sequenceMode === 'mentionFirst') {
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [极速版] 正在粘贴提及第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
      }
      if (!isStopping) {
        exec(`osascript -e 'tell application "System Events" to keystroke return using shift down'`);
        await new Promise(res => setTimeout(res, 150));
        event.reply('status-update', '🔗 正在追加正文内容...');
        await pasteRichContent(htmlContent, textContent);
      }
    } else {
      event.reply('status-update', '🔗 正在首发注入消息正文内容...');
      await pasteRichContent(htmlContent, textContent);
      
      exec(`osascript -e 'tell application "System Events" to keystroke return using shift down'`);
      await new Promise(res => setTimeout(res, 150));

      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [极速版] 正在追加提及第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
      }
    }

    if (isStopping) {
      event.reply('status-update', '⏹️ 自动化已被安全中断。');
    } else {
      event.reply('status-update', '✅ 终极无空格高并发注入已完美交付！');
    }
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  });
});

ipcMain.on('stop-automation', () => { isStopping = true; });
