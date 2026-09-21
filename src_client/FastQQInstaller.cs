using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Diagnostics;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FastQQInstaller
{
    public class Program
    {
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }

    public class InstallerForm : Form
    {
        private TextBox txtPath;
        private CheckBox chkDesktop;
        private CheckBox chkStartMenu;
        private CheckBox chkLaunch;
        private ProgressBar progressBar;
        private Button btnInstall;

        public InstallerForm()
        {
            InitUI();
        }

        private void InitUI()
        {
            this.Text = "Linkey - 客户端安装向导";
            this.Size = new Size(540, 420);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = Color.FromArgb(11, 15, 25);
            this.ForeColor = Color.White;
            this.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular);

            try
            {
                string icoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                if (File.Exists(icoPath)) this.Icon = new Icon(icoPath);
            }
            catch { }

            // Header Panel
            Panel headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 85;
            headerPanel.BackColor = Color.FromArgb(16, 22, 36);

            Label lblTitle = new Label();
            lblTitle.Text = "欢迎安装 Linkey 客户端";
            lblTitle.Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(0, 242, 254);
            lblTitle.Location = new Point(24, 18);
            lblTitle.Size = new Size(480, 28);
            headerPanel.Controls.Add(lblTitle);

            Label lblSub = new Label();
            lblSub.Text = "现代轻量即时通讯客户端 · 连接每一刻";
            lblSub.ForeColor = Color.FromArgb(160, 180, 205);
            lblSub.Location = new Point(26, 48);
            lblSub.Size = new Size(480, 22);
            headerPanel.Controls.Add(lblSub);

            this.Controls.Add(headerPanel);

            // Install Path
            Label lblPath = new Label();
            lblPath.Text = "安装目标路径：";
            lblPath.Location = new Point(24, 110);
            lblPath.Size = new Size(150, 22);
            this.Controls.Add(lblPath);

            string defaultDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Linkey");

            txtPath = new TextBox();
            txtPath.Text = defaultDir;
            txtPath.Location = new Point(24, 135);
            txtPath.Size = new Size(380, 26);
            txtPath.BackColor = Color.FromArgb(24, 32, 52);
            txtPath.ForeColor = Color.White;
            this.Controls.Add(txtPath);

            Button btnBrowse = new Button();
            btnBrowse.Text = "浏览...";
            btnBrowse.Location = new Point(415, 133);
            btnBrowse.Size = new Size(85, 29);
            btnBrowse.BackColor = Color.FromArgb(30, 42, 68);
            btnBrowse.ForeColor = Color.White;
            btnBrowse.FlatStyle = FlatStyle.Flat;
            btnBrowse.Click += (s, e) => {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = txtPath.Text;
                    if (fbd.ShowDialog(this) == DialogResult.OK)
                    {
                        txtPath.Text = fbd.SelectedPath;
                    }
                }
            };
            this.Controls.Add(btnBrowse);

            // Options
            chkDesktop = new CheckBox();
            chkDesktop.Text = "创建桌面快捷方式 (推荐)";
            chkDesktop.Checked = true;
            chkDesktop.Location = new Point(28, 185);
            chkDesktop.Size = new Size(300, 24);
            this.Controls.Add(chkDesktop);

            chkStartMenu = new CheckBox();
            chkStartMenu.Text = "添加到 Windows 开始菜单";
            chkStartMenu.Checked = true;
            chkStartMenu.Location = new Point(28, 215);
            chkStartMenu.Size = new Size(300, 24);
            this.Controls.Add(chkStartMenu);

            chkLaunch = new CheckBox();
            chkLaunch.Text = "安装完成后立即启动 Linkey";
            chkLaunch.Checked = true;
            chkLaunch.Location = new Point(28, 245);
            chkLaunch.Size = new Size(300, 24);
            this.Controls.Add(chkLaunch);

            // Progress Bar
            progressBar = new ProgressBar();
            progressBar.Location = new Point(24, 285);
            progressBar.Size = new Size(475, 16);
            progressBar.Visible = false;
            this.Controls.Add(progressBar);

            // Bottom Buttons
            btnInstall = new Button();
            btnInstall.Text = "🚀 立即一键安装";
            btnInstall.Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Bold);
            btnInstall.Location = new Point(160, 320);
            btnInstall.Size = new Size(180, 40);
            btnInstall.BackColor = Color.FromArgb(0, 114, 255);
            btnInstall.ForeColor = Color.White;
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.Click += (s, e) => DoInstall();
            this.Controls.Add(btnInstall);

            Button btnCancel = new Button();
            btnCancel.Text = "取消";
            btnCancel.Location = new Point(360, 320);
            btnCancel.Size = new Size(110, 40);
            btnCancel.BackColor = Color.FromArgb(30, 42, 68);
            btnCancel.ForeColor = Color.White;
            btnCancel.FlatStyle = FlatStyle.Flat;
            btnCancel.Click += (s, e) => this.Close();
            this.Controls.Add(btnCancel);
        }

        private void DoInstall()
        {
            string targetDir = txtPath.Text.Trim();
            if (string.IsNullOrEmpty(targetDir)) return;

            btnInstall.Enabled = false;
            progressBar.Visible = true;
            progressBar.Value = 20;

            try
            {
                if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

                string curDir = AppDomain.CurrentDomain.BaseDirectory;
                string exeSrc = Path.Combine(curDir, "Linkey.exe");
                if (!File.Exists(exeSrc)) exeSrc = Path.Combine(curDir, "极速QQ-电脑版.exe");
                if (!File.Exists(exeSrc)) exeSrc = Path.Combine(curDir, "极速QQ.exe");

                string targetExe = Path.Combine(targetDir, "Linkey.exe");
                if (File.Exists(exeSrc))
                {
                    File.Copy(exeSrc, targetExe, true);
                }

                // Copy app.ico & config if exists
                string icoSrc = Path.Combine(curDir, "app.ico");
                string targetIco = Path.Combine(targetDir, "app.ico");
                if (File.Exists(icoSrc)) File.Copy(icoSrc, targetIco, true);

                string cfgSrc = Path.Combine(curDir, "Linkey-Config.json");
                if (!File.Exists(cfgSrc)) cfgSrc = Path.Combine(curDir, "FastQQ-Config.json");
                string targetCfg = Path.Combine(targetDir, "Linkey-Config.json");
                if (File.Exists(cfgSrc))
                {
                    File.Copy(cfgSrc, targetCfg, true);
                }
                else
                {
                    File.WriteAllText(targetCfg, "{\n  \"server_url\": \"http://192.168.1.8:3000\"\n}", Encoding.UTF8);
                }

                progressBar.Value = 60;

                // Browser Emulation Registry
                try
                {
                    using (RegistryKey rk = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION"))
                    {
                        if (rk != null)
                        {
                            rk.SetValue("Linkey.exe", 11001, RegistryValueKind.DWord);
                        }
                    }
                }
                catch { }

                // Create Shortcuts
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType);

                    if (chkDesktop.Checked)
                    {
                        string desktopPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Linkey.lnk");
                        dynamic sc = shell.CreateShortcut(desktopPath);
                        sc.TargetPath = targetExe;
                        sc.WorkingDirectory = targetDir;
                        sc.Description = "Linkey 客户端";
                        if (File.Exists(targetIco)) sc.IconLocation = targetIco + ",0";
                        sc.Save();
                    }

                    if (chkStartMenu.Checked)
                    {
                        string smDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
                        string smPath = Path.Combine(smDir, "Linkey.lnk");
                        dynamic sc = shell.CreateShortcut(smPath);
                        sc.TargetPath = targetExe;
                        sc.WorkingDirectory = targetDir;
                        sc.Description = "Linkey 客户端";
                        if (File.Exists(targetIco)) sc.IconLocation = targetIco + ",0";
                        sc.Save();
                    }
                }

                progressBar.Value = 100;

                MessageBox.Show("Linkey 客户端已成功安装到您的电脑！\n\n目标位置：" + targetDir, "安装成功", MessageBoxButtons.OK, MessageBoxIcon.Information);

                if (chkLaunch.Checked && File.Exists(targetExe))
                {
                    Process.Start(new ProcessStartInfo(targetExe) { WorkingDirectory = targetDir });
                }

                this.Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装过程中发生错误: " + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                btnInstall.Enabled = true;
            }
        }
    }
}
