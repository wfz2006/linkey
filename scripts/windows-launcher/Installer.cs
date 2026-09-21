using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Diagnostics;

namespace FastQQInstaller
{
    public class InstallerForm : Form
    {
        private Label titleLabel;
        private Label subLabel;
        private Label ipLabel;
        private TextBox ipTextBox;
        private Button installBtn;
        private ProgressBar progressBar;
        private Label statusLabel;

        public InstallerForm()
        {
            this.Text = "Linkey - 一键安装程序";
            this.Size = new Size(480, 360);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(245, 248, 252);
            this.Font = new Font("Microsoft YaHei", 9.5f, FontStyle.Regular);

            // Title
            titleLabel = new Label();
            titleLabel.Text = "Linkey 客户端安装";
            titleLabel.Font = new Font("Microsoft YaHei", 14f, FontStyle.Bold);
            titleLabel.ForeColor = Color.FromArgb(18, 183, 245);
            titleLabel.Location = new Point(30, 25);
            titleLabel.AutoSize = true;
            this.Controls.Add(titleLabel);

            // Subtitle
            subLabel = new Label();
            subLabel.Text = "全自适应跨端即时通讯 · 电脑与手机毫秒互联";
            subLabel.ForeColor = Color.Gray;
            subLabel.Location = new Point(32, 60);
            subLabel.AutoSize = true;
            this.Controls.Add(subLabel);

            // IP Label
            ipLabel = new Label();
            ipLabel.Text = "备用电脑服务器 IP (本机作为服务器时填写 127.0.0.1)：";
            ipLabel.Location = new Point(32, 110);
            ipLabel.AutoSize = true;
            this.Controls.Add(ipLabel);

            // IP TextBox
            ipTextBox = new TextBox();
            ipTextBox.Text = "127.0.0.1";
            ipTextBox.Location = new Point(32, 140);
            ipTextBox.Size = new Size(400, 30);
            ipTextBox.Font = new Font("Microsoft YaHei", 10.5f, FontStyle.Regular);
            this.Controls.Add(ipTextBox);

            // Progress Bar
            progressBar = new ProgressBar();
            progressBar.Location = new Point(32, 190);
            progressBar.Size = new Size(400, 18);
            progressBar.Visible = false;
            this.Controls.Add(progressBar);

            // Status Label
            statusLabel = new Label();
            statusLabel.Text = "准备安装...";
            statusLabel.ForeColor = Color.FromArgb(18, 183, 245);
            statusLabel.Location = new Point(32, 215);
            statusLabel.AutoSize = true;
            statusLabel.Visible = false;
            this.Controls.Add(statusLabel);

            // Install Button
            installBtn = new Button();
            installBtn.Text = "⚡ 立即一键安装并运行";
            installBtn.Font = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold);
            installBtn.BackColor = Color.FromArgb(18, 183, 245);
            installBtn.ForeColor = Color.White;
            installBtn.FlatStyle = FlatStyle.Flat;
            installBtn.FlatAppearance.BorderSize = 0;
            installBtn.Size = new Size(400, 45);
            installBtn.Location = new Point(32, 245);
            installBtn.Cursor = Cursors.Hand;
            installBtn.Click += new EventHandler(OnInstallClick);
            this.Controls.Add(installBtn);
        }

        private void OnInstallClick(object sender, EventArgs e)
        {
            string serverIp = ipTextBox.Text.Trim();
            if (string.IsNullOrEmpty(serverIp)) serverIp = "127.0.0.1";

            installBtn.Enabled = false;
            progressBar.Visible = true;
            progressBar.Value = 30;
            statusLabel.Visible = true;
            statusLabel.Text = "正在解压并创建程序目录...";

            try
            {
                string targetDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Linkey");
                if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

                // Write server_ip.txt
                File.WriteAllText(Path.Combine(targetDir, "server_ip.txt"), serverIp);

                // Copy Client executable
                string currentDir = AppDomain.CurrentDomain.BaseDirectory;
                string sourceExe = Path.Combine(currentDir, "Linkey.exe");
                string destExe = Path.Combine(targetDir, "Linkey.exe");

                if (File.Exists(sourceExe))
                {
                    File.Copy(sourceExe, destExe, true);
                }

                progressBar.Value = 70;
                statusLabel.Text = "正在创建桌面与开始菜单快捷方式...";

                // Create Desktop Shortcut using VBScript
                string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                string lnkPath = Path.Combine(desktopPath, "Linkey.lnk");
                CreateShortcut(lnkPath, destExe, targetDir);

                progressBar.Value = 100;
                statusLabel.Text = "安装完成！正在启动 Linkey...";

                    // Launch Linkey
                if (File.Exists(destExe))
                {
                    Process.Start(destExe);
                }
                else
                {
                    // If source in same directory, launch via URL
                    string url = "http://" + serverIp + (serverIp.Contains(":") ? "" : ":3000");
                    Process.Start(url);
                }

                Timer t = new Timer();
                t.Interval = 1200;
                t.Tick += (s, ev) => { t.Stop(); this.Close(); };
                t.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装过程出现提示: " + ex.Message, "安装提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                this.Close();
            }
        }

        private void CreateShortcut(string shortcutFile, string targetFile, string workingDir)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutFile);
                shortcut.TargetPath = targetFile;
                shortcut.WorkingDirectory = workingDir;
                shortcut.Description = "Linkey 客户端";
                shortcut.Save();
            }
            catch { }
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
