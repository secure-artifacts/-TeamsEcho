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

  // 安全护栏：强拦截关闭窗口行为，不留持久化痕迹
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

// 基于用户 M 芯片参数深度调优的 AppleScript 桥接执行
function runAppleScriptForPerson(name) {
  return new Promise((resolve) => {
    // 精确映射极速版执行链：@ -> 左键 -> 粘贴名字 -> 按1 -> 删除 -> 回车
    const script = `
      tell application "Microsoft Teams" to activate
      delay 0.1
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
    exec(`osascript -e '${script}'`, (err) => {
      resolve(err ? false : true);
    });
  });
}

// 模拟最后一步粘贴富文本内容
function pasteRichContent(html, text) {
  clipboard.write({ html: html, text: text });
  const script = `
    tell application "Microsoft Teams" to activate
    delay 0.1
    tell application "System Events"
      keystroke "v" using command down
      delay 0.1
    end tell
  `;
  exec(`osascript -e '${script}'`);
}

ipcMain.on('start-automation', async (event, data) => {
  const { names, htmlContent, textContent } = data;
  isStopping = false;
  const originalClipboard = clipboard.readText();

  // 运行前前台校验流，前置激活 Teams 窗口
  exec('osascript -e \'tell application "Microsoft Teams" to activate\'', async (err) => {
    if (err) {
      event.reply('status-update', '❌ 错误: 未能在系统中检测到 Microsoft Teams 客户端！');
      return;
    }

    for (let i = 0; i < names.length; i++) {
      if (isStopping) {
        event.reply('status-update', '⏹️ 自动化已被中断，当前已安全停止。');
        clipboard.writeText(originalClipboard);
        return;
      }

      event.reply('status-update', `📈 正在 @ 第 ${i + 1}/${names.length} 位成员：${names[i]}`);
      await runAppleScriptForPerson(names[i]);
    }

    // 所有人员 @ 提及完毕后，把带有富文本格式和链接的消息体直接一次性灌入 Teams 输入框中
    event.reply('status-update', '🔗 正在注入带格式的消息正文...');
    pasteRichContent(htmlContent, textContent);
    event.reply('status-update', '✅ 批量 @ 提及与富文本消息注入已全部完美完成！');
    
    // 彻底销毁敏感剪贴板缓存，保障隐私
    setTimeout(() => { clipboard.writeText(originalClipboard); }, 500);
  });
});

ipcMain.on('stop-automation', () => {
  isStopping = true;
});
