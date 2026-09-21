using System;
using System.IO;
using System.Net;
using System.Text;
using System.Drawing;
using System.Diagnostics;
using System.Windows.Forms;
using System.Net.NetworkInformation;
using Microsoft.Win32;

namespace FastQQClient
{
    public class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Linkey-Config.json");
            string legacyConfigPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FastQQ-Config.json");
            if (!File.Exists(configPath) && File.Exists(legacyConfigPath)) configPath = legacyConfigPath;
            // 默认本机直连；若配置文件存在则以配置为准
            string serverUrl = "http://127.0.0.1:3000";

            if (File.Exists(configPath))
            {
                try
                {
                    string json = File.ReadAllText(configPath, Encoding.UTF8);
                    int idx = json.IndexOf("\"server_url\"");
                    if (idx >= 0)
                    {
                        int colon = json.IndexOf(':', idx);
                        int q1 = json.IndexOf('\"', colon);
                        int q2 = json.IndexOf('\"', q1 + 1);
                        if (q1 >= 0 && q2 > q1)
                        {
                            string u = json.Substring(q1 + 1, q2 - q1 - 1).Trim();
                            if (!string.IsNullOrEmpty(u)) serverUrl = u;
                        }
                    }
                }
                catch { }
            }

            // Check if user passed /config or if server is not reachable
            bool showConfig = false;
            foreach (string arg in args)
            {
                if (arg.Equals("/config", StringComparison.OrdinalIgnoreCase) || arg.Equals("-config", StringComparison.OrdinalIgnoreCase))
                {
                    showConfig = true;
                    break;
                }
            }

            if (showConfig)
            {
                serverUrl = ShowConfigDialog(serverUrl, configPath);
                if (string.IsNullOrEmpty(serverUrl)) return;
            }

            // ===== 连接探测与自动修复 =====
            // 1. 配置地址连不通时，自动探测本机候选地址并回写配置（解决房主 IP 变动导致的白屏）
            if (!IsServerAlive(serverUrl))
            {
                string found = DiscoverServer();
                if (found != null)
                {
                    serverUrl = found;
                    SaveConfig(configPath, found);
                }
                else
                {
                    // 2. 全部候选不可达：显示等待窗口，自动重试 + 手动改址，直到连上为止
                    string recovered = ShowOfflineWaitDialog(serverUrl, configPath);
                    if (string.IsNullOrEmpty(recovered)) return; // 用户选择退出
                    serverUrl = recovered;
                }
            }

            // Find Modern Chromium Browser (Edge or Chrome)
            string browserPath = FindModernBrowser();

            if (string.IsNullOrEmpty(browserPath))
            {
                // Fallback: system default browser
                Process.Start(new ProcessStartInfo(serverUrl) { UseShellExecute = true });
                return;
            }

            // Linkey uses its own profile; reuse the legacy profile when upgrading so saved sessions remain available.
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dataDir = Path.Combine(localAppData, "Linkey", "AppData");
            string legacyDataDir = Path.Combine(localAppData, "FastQQ", "AppData");
            if (!Directory.Exists(dataDir) && Directory.Exists(legacyDataDir)) dataDir = legacyDataDir;
            if (!Directory.Exists(dataDir)) Directory.CreateDirectory(dataDir);

            // Launch in standalone Chromium App Window Mode
            string appArgs = string.Format("--app=\"{0}\" --window-size=1200,850 --user-data-dir=\"{1}\" --enable-smooth-scrolling --disable-features=Translate", serverUrl, dataDir);

            ProcessStartInfo psi = new ProcessStartInfo(browserPath, appArgs);
            psi.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
            psi.UseShellExecute = false;

            try
            {
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动 Linkey 客户端失败: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Process.Start(new ProcessStartInfo(serverUrl) { UseShellExecute = true });
            }
        }

        /// <summary>探测服务器是否可达（/healthz），短超时快速失败</summary>
        private static bool IsServerAlive(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            try
            {
                string probeUrl = url.TrimEnd('/') + "/healthz";
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(probeUrl);
                req.Method = "GET";
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                req.Proxy = null;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode < 500;
                }
            }
            catch (WebException wex)
            {
                HttpWebResponse errResp = wex.Response as HttpWebResponse;
                if (errResp != null) return (int)errResp.StatusCode < 500;
                return false;
            }
            catch { return false; }
        }

        /// <summary>遍历候选地址寻找存活的服务端：本机回环 → 本机各网卡 IP</summary>
        private static string DiscoverServer()
        {
            foreach (string url in CandidateUrls())
            {
                if (IsServerAlive(url)) return url;
            }
            return null;
        }

        private static System.Collections.Generic.IEnumerable<string> CandidateUrls()
        {
            yield return "http://127.0.0.1:3000";
            yield return "http://localhost:3000";

            System.Collections.Generic.List<string> ips = new System.Collections.Generic.List<string>();
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (UnicastIPAddressInformation info in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (info.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                        {
                            string ip = info.Address.ToString();
                            if (!ip.StartsWith("169.254.")) // 排除自动专有地址
                            {
                                ips.Add("http://" + ip + ":3000");
                            }
                        }
                    }
                }
            }
            catch { }

            foreach (string u in ips) yield return u;
        }

        private static void SaveConfig(string configPath, string url)
        {
            try
            {
                File.WriteAllText(configPath, "{\n  \"server_url\": \"" + url + "\"\n}", Encoding.UTF8);
            }
            catch { }
        }

        /// <summary>
        /// 服务不可达时的等待窗口：后台每 3 秒自动重试（含候选地址自动发现），
        /// 连上后自动关闭并继续启动；也可手动重试 / 更改地址 / 退出。
        /// 返回最终可用的服务器地址，返回 null 表示用户退出。
        /// </summary>
        private static string ShowOfflineWaitDialog(string configuredUrl, string configPath)
        {
            string result = null;
            string currentTarget = configuredUrl;

            using (Form dlg = new Form())
            {
                dlg.Text = "Linkey - 正在连接服务器";
                dlg.Size = new Size(480, 250);
                dlg.StartPosition = FormStartPosition.CenterScreen;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;
                dlg.BackColor = Color.FromArgb(11, 15, 25);
                dlg.ForeColor = Color.White;
                dlg.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular);

                Label lblTitle = new Label();
                lblTitle.Text = "⚠ 无法连接服务器";
                lblTitle.Location = new Point(24, 18);
                lblTitle.Size = new Size(420, 26);
                lblTitle.Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold);
                lblTitle.ForeColor = Color.FromArgb(245, 158, 11);
                dlg.Controls.Add(lblTitle);

                Label lblUrl = new Label();
                lblUrl.Text = configuredUrl;
                lblUrl.Location = new Point(24, 52);
                lblUrl.Size = new Size(420, 22);
                lblUrl.ForeColor = Color.FromArgb(0, 242, 254);
                dlg.Controls.Add(lblUrl);

                Label lblHint = new Label();
                lblHint.Text = "请确认服务端已启动（在房主电脑上双击 admin-start.cmd）。\n本客户端正在自动重试，连上后将自动进入；若房主已换网络，\n请点击【设置服务器地址】输入房主的最新 IP。";
                lblHint.Location = new Point(24, 84);
                lblHint.Size = new Size(420, 72);
                lblHint.ForeColor = Color.FromArgb(160, 175, 200);
                dlg.Controls.Add(lblHint);

                Label lblStatus = new Label();
                lblStatus.Text = "状态: 正在等待服务器上线...";
                lblStatus.Location = new Point(24, 160);
                lblStatus.Size = new Size(420, 20);
                lblStatus.ForeColor = Color.FromArgb(120, 200, 130);
                dlg.Controls.Add(lblStatus);

                Button btnRetry = new Button();
                btnRetry.Text = "立即重试";
                btnRetry.Location = new Point(24, 190);
                btnRetry.Size = new Size(110, 34);
                btnRetry.BackColor = Color.FromArgb(0, 114, 255);
                btnRetry.ForeColor = Color.White;
                btnRetry.FlatStyle = FlatStyle.Flat;
                dlg.Controls.Add(btnRetry);

                Button btnConfig = new Button();
                btnConfig.Text = "设置服务器地址";
                btnConfig.Location = new Point(150, 190);
                btnConfig.Size = new Size(140, 34);
                btnConfig.BackColor = Color.FromArgb(30, 42, 68);
                btnConfig.ForeColor = Color.White;
                btnConfig.FlatStyle = FlatStyle.Flat;
                dlg.Controls.Add(btnConfig);

                Button btnQuit = new Button();
                btnQuit.Text = "退出";
                btnQuit.Location = new Point(305, 190);
                btnQuit.Size = new Size(80, 34);
                btnQuit.BackColor = Color.FromArgb(30, 42, 68);
                btnQuit.ForeColor = Color.White;
                btnQuit.FlatStyle = FlatStyle.Flat;
                dlg.Controls.Add(btnQuit);

                // 后台线程轮询：不阻塞 UI；成功后回 UI 线程关闭窗口
                bool stopProbing = false;

                Action tryConnectAsync = delegate()
                {
                    System.Threading.Thread worker = new System.Threading.Thread(delegate()
                    {
                        int waitSeconds = 0;
                        while (!stopProbing)
                        {
                            bool alive = IsServerAlive(currentTarget);
                            if (!alive)
                            {
                                string found = DiscoverServer();
                                if (found != null)
                                {
                                    currentTarget = found;
                                    alive = true;
                                    SaveConfig(configPath, found);
                                }
                            }

                            if (stopProbing) break;

                            if (alive)
                            {
                                result = currentTarget;
                                try { dlg.BeginInvoke((MethodInvoker)delegate()
                                {
                                    dlg.DialogResult = DialogResult.OK;
                                    dlg.Close();
                                }); } catch { }
                                break;
                            }

                            string status = "状态: 已等待 " + waitSeconds + " 秒，继续自动重试中... (每 3 秒)";
                            try { dlg.BeginInvoke((MethodInvoker)delegate() { lblStatus.Text = status; }); } catch { }
                            waitSeconds += 3;
                            System.Threading.Thread.Sleep(3000);
                        }
                    });
                    worker.IsBackground = true;
                    worker.Start();
                };

                btnRetry.Click += (s, e) => { lblStatus.Text = "状态: 正在重试..."; tryConnectAsync(); };
                btnConfig.Click += (s, e) =>
                {
                    string picked = ShowConfigDialog(currentTarget, configPath);
                    if (!string.IsNullOrEmpty(picked))
                    {
                        currentTarget = picked;
                        lblUrl.Text = picked;
                        tryConnectAsync();
                    }
                };
                btnQuit.Click += (s, e) => { stopProbing = true; dlg.DialogResult = DialogResult.Cancel; dlg.Close(); };
                dlg.FormClosed += (s, e) => { stopProbing = true; };

                dlg.Shown += (s, e) => tryConnectAsync();

                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    return result;
                }
                return null;
            }
        }

        private static string FindModernBrowser()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string p in candidates)
            {
                if (File.Exists(p)) return p;
            }

            try
            {
                using (RegistryKey rk = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
                {
                    if (rk != null)
                    {
                        string p = rk.GetValue("") as string;
                        if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
                    }
                }
                using (RegistryKey rk = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"))
                {
                    if (rk != null)
                    {
                        string p = rk.GetValue("") as string;
                        if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
                    }
                }
            }
            catch { }

            return null;
        }

        private static string ShowConfigDialog(string currentUrl, string configPath)
        {
            using (Form dlg = new Form())
            {
                dlg.Text = "Linkey - 服务器连接配置";
                dlg.Size = new Size(480, 240);
                dlg.StartPosition = FormStartPosition.CenterScreen;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;
                dlg.BackColor = Color.FromArgb(11, 15, 25);
                dlg.ForeColor = Color.White;
                dlg.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular);

                Label lbl = new Label();
                lbl.Text = "请输入 Linkey 服务端地址 (若与朋友在同一 WiFi，请输入房主 IP 地址):";
                lbl.Location = new Point(24, 18);
                lbl.Size = new Size(420, 36);
                lbl.ForeColor = Color.FromArgb(200, 215, 240);
                dlg.Controls.Add(lbl);

                TextBox txt = new TextBox();
                txt.Text = currentUrl;
                txt.Location = new Point(24, 65);
                txt.Size = new Size(415, 26);
                txt.BackColor = Color.FromArgb(24, 32, 52);
                txt.ForeColor = Color.FromArgb(0, 242, 254);
                dlg.Controls.Add(txt);

                string selected = currentUrl;

                Button btnOk = new Button();
                btnOk.Text = "保存并启动";
                btnOk.Location = new Point(190, 120);
                btnOk.Size = new Size(120, 36);
                btnOk.BackColor = Color.FromArgb(0, 114, 255);
                btnOk.ForeColor = Color.White;
                btnOk.FlatStyle = FlatStyle.Flat;
                btnOk.Click += (s, e) => {
                    selected = txt.Text.Trim();
                    if (!string.IsNullOrEmpty(selected))
                    {
                        try
                        {
                            File.WriteAllText(configPath, "{\n  \"server_url\": \"" + selected + "\"\n}", Encoding.UTF8);
                        }
                        catch { }
                        dlg.DialogResult = DialogResult.OK;
                        dlg.Close();
                    }
                };
                dlg.Controls.Add(btnOk);

                Button btnCancel = new Button();
                btnCancel.Text = "取消";
                btnCancel.Location = new Point(325, 120);
                btnCancel.Size = new Size(110, 36);
                btnCancel.BackColor = Color.FromArgb(30, 42, 68);
                btnCancel.ForeColor = Color.White;
                btnCancel.FlatStyle = FlatStyle.Flat;
                btnCancel.Click += (s, e) => {
                    dlg.DialogResult = DialogResult.Cancel;
                    dlg.Close();
                };
                dlg.Controls.Add(btnCancel);

                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    return selected;
                }
                return null;
            }
        }
    }
}
