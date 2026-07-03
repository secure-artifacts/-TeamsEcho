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
        delay 0.15
        key code 36
        delay 0.05
      end tell
    `;
    clipboard.writeText(name);
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

function sendNativeKey(keyCode) {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "System Events" to key code ${keyCode}'`, () => { resolve(); });
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

    event.reply('status-update', '🛡️ 安全机制：正在强制 Teams 开启富文本长文模式...');
    await new Promise((res) => {
      exec(`osascript -e 'tell application "System Events" to keystroke "x" using {command down, shift down}'`, () => res());
    });
    await new Promise(res => setTimeout(res, 300));

    // 执行分支控制：判定用户自选的顺序模式
    if (sequenceMode === 'mentionFirst') {
      // 模式一：先 @ 提及，再发消息体
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [模式A] 正在 @ 第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
        await new Promise((res) => { exec(`osascript -e 'tell application "System Events" to keystroke " "'`, () => res()); });
      }
      if (!isStopping) {
        // 在 @ 完所有人后换个行，再灌入正文，排版最规整
        await sendNativeKey(36); 
        event.reply('status-update', '🔗 正在追加正文内容...');
        await pasteRichContent(htmlContent, textContent);
      }
    } else {
      // 模式二：先发正文，再在末尾追加 @ 提及
      event.reply('status-update', '🔗 正在首发注入消息正文内容...');
      await pasteRichContent(htmlContent, textContent);
      // 正文灌入后换行，让 @ 名单整齐列在尾部
      await sendNativeKey(36); 

      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [模式B] 正在追加 @ 第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
        await new Promise((res) => { exec(`osascript -e 'tell application "System Events" to keystroke " "'`, () => res()); });
      }
    }

    if (isStopping) {
      event.reply('status-update', '⏹️ 自动化已被安全中断。');
    } else {
      event.reply('status-update', '✅ 全流程自动化注入已全部完美完成！');
    }
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  });
});

ipcMain.on('stop-automation', () => { isStopping = true; });
