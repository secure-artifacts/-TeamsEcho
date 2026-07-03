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

// 核心调优的单人提及 AppleScript 流
function runAppleScriptForPerson(name) {
  return new Promise((resolve) => {
    // 严格动作链：输入@ -> 左移光标 -> 粘贴完整名字 -> 输入1触发模糊联想 -> 退格删除1 -> 回车确认
    const script = `
      tell application "Microsoft Teams" to activate
      delay 0.05
      tell application "System Events"
        keystroke "@"
        delay 0.05
        key code 123
        delay 0.05
        keystroke "v" using command down
        delay 0.15
        keystroke "1"
        delay 0.05
        key code 51
        delay 0.2
        key code 36
        delay 0.1
      end tell
    `;
    clipboard.writeText(name);
    exec(`osascript -e '${script}'`, (err) => { resolve(err ? false : true); });
  });
}

// 粘贴富文本内容
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

// 模拟原生按键
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
    exec(`osascript -e 'tell application "System Events" to keystroke "x" using {command down, shift down}'`);
    await new Promise(res => setTimeout(res, 400));

    // 分支判定：先 @ 还是先发正文
    if (sequenceMode === 'mentionFirst') {
      // 模式 A：先批量 @ 提及成员 ──> 再追加消息正文内容
      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [先@后文] 正在 @ 第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
        
        // 每 @ 完一个人，输入一个空格并稍微等待，确保蓝字气泡完全闭环且相互独立
        await new Promise((res) => {
          exec(`osascript -e 'tell application "System Events" to keystroke " "'`, () => setTimeout(res, 100));
        });
      }
      if (!isStopping) {
        // @ 完所有人后，按 Shift+Return 实现优雅的富文本内换行
        exec(`osascript -e 'tell application "System Events" to keystroke return using shift down'`);
        await new Promise(res => setTimeout(res, 200));
        
        event.reply('status-update', '🔗 正在追加正文内容...');
        await pasteRichContent(htmlContent, textContent);
      }
    } else {
      // 模式 B：先写入消息正文内容 ──> 再在末尾批量 @ 提及成员
      event.reply('status-update', '🔗 正在首发注入消息正文内容...');
      await pasteRichContent(htmlContent, textContent);
      
      // 正文结束后，按 Shift+Return 换行，准备在下方追加 @ 名单
      exec(`osascript -e 'tell application "System Events" to keystroke return using shift down'`);
      await new Promise(res => setTimeout(res, 200));

      for (let i = 0; i < names.length; i++) {
        if (isStopping) break;
        event.reply('status-update', `📈 [先文后@] 正在追加 @ 第 ${i + 1}/${names.length} 位：${names[i]}`);
        await runAppleScriptForPerson(names[i]);
        await new Promise((res) => {
          exec(`osascript -e 'tell application "System Events" to keystroke " "'`, () => setTimeout(res, 100));
        });
      }
    }

    if (isStopping) {
      event.reply('status-update', '⏹️ 自动化已被安全中断。');
    } else {
      event.reply('status-update', '✅ 全流程自动化 client 级注入已完美交付！');
    }
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  });
});

ipcMain.on('stop-automation', () => { isStopping = true; });
