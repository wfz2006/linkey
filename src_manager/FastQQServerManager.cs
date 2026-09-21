using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Net;
using System.Threading;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace FastQQ.ServerManager
{
    public class MainForm : Form
    {
        // ===== UI 引用 =====
        private Panel sidebar;
        private Button navOverview;
        private Button navLogs;
        private Button navTools;

        private Panel viewOverview;
        private Panel viewLogs;
        private Panel viewTools;

        private Label lblHeaderTitle;
        private Label lblServerStatusBadge;

        private Label valAppState;        private Label subAppState;
        private Label valDaemonState;     private Label subDaemonState;
        private Label valTunnelState;     private Label subTunnelState;
        private Label valDataState;       private Label subDataState;

        private Button btnStartServer;
        private Button btnRestartServer;
        private Button btnStopServer;

        private TextBox txtLiveLogs;
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;

        // ===== 运行时状态 =====
        private Process adminProcess = null;
        private System.Windows.Forms.Timer statusTimer;
        private string appRootDir;
        private string nodeExecutable;
        private bool isExiting = false;
        private int backupCountCache = -1;
        private DateTime backupCountAt = DateTime.MinValue;
        private Panel migrationCard;
        private bool migrationBusy;

        private static readonly Regex RxTunnelUrl = new Regex("\"publicUrl\"\\s*:\\s*\"([^\"]+)\"", RegexOptions.Compiled);
        private static readonly Regex RxUpdatedAt = new Regex("\"updatedAt\"\\s*:\\s*([0-9]+)", RegexOptions.Compiled);

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        public MainForm()
        {
            appRootDir = AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(appRootDir, "admin", "admin.js")) && File.Exists(Path.Combine(appRootDir, "..", "admin", "admin.js")))
            {
                appRootDir = Path.GetFullPath(Path.Combine(appRootDir, ".."));
            }

            FindNodeExecutable();
            InitializeComponent();
            SetupTrayIcon();

            statusTimer = new System.Windows.Forms.Timer();
            statusTimer.Interval = 2000;
            statusTimer.Tick += (s, e) => RefreshStatusAsync();
            statusTimer.Start();

            AutoStartServerIfStopped();
        }

        private void FindNodeExecutable()
        {
            string[] possiblePaths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Antigravity\bin\agy-node.cmd"),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
                "node"
            };

            foreach (string p in possiblePaths)
            {
                if (File.Exists(p) || p == "node")
                {
                    nodeExecutable = p;
                    break;
                }
            }

            if (string.IsNullOrEmpty(nodeExecutable))
            {
                nodeExecutable = "node";
            }
        }

        // =====================================================================
        // UI 构建：现代深色控制台（侧边导航 + 仪表盘卡片 + 日志 + 工具）
        // =====================================================================
        private void InitializeComponent()
        {
            this.Text = "Linkey · 服务端与后台管理系统";
            this.Size = new Size(1180, 800);
            this.MinimumSize = new Size(1000, 680);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(10, 14, 23);
            this.ForeColor = Color.White;
            this.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);

            try { this.Icon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName); }
            catch {}

            // ---------- 顶部标题栏 ----------
            Panel pnlHeader = new Panel();
            pnlHeader.Dock = DockStyle.Top;
            pnlHeader.Height = 72;
            pnlHeader.BackColor = Color.FromArgb(15, 21, 36);
            pnlHeader.Padding = new Padding(18, 12, 18, 12);

            lblHeaderTitle = new Label();
            lblHeaderTitle.Text = "Linkey 服务端管理系统";
            lblHeaderTitle.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            lblHeaderTitle.ForeColor = Color.FromArgb(0, 242, 254);
            lblHeaderTitle.AutoSize = true;
            lblHeaderTitle.Location = new Point(18, 10);

            lblServerStatusBadge = new Label();
            lblServerStatusBadge.Text = "● 正在检测服务状态...";
            lblServerStatusBadge.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            lblServerStatusBadge.ForeColor = Color.FromArgb(245, 158, 11);
            lblServerStatusBadge.AutoSize = true;
            lblServerStatusBadge.Location = new Point(22, 42);

            Label lblPorts = new Label();
            lblPorts.Text = "主服务 :3000 · 管理端 :3001";
            lblPorts.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblPorts.ForeColor = Color.FromArgb(100, 116, 139);
            lblPorts.AutoSize = true;
            lblPorts.Location = new Point(340, 44);

            FlowLayoutPanel pnlHeaderActions = new FlowLayoutPanel();
            pnlHeaderActions.Dock = DockStyle.Right;
            pnlHeaderActions.FlowDirection = FlowDirection.RightToLeft;
            pnlHeaderActions.AutoSize = true;
            pnlHeaderActions.WrapContents = false;
            pnlHeaderActions.Padding = new Padding(0, 2, 0, 0);

            btnStartServer = CreateStyledButton("▶ 启动服务", Color.FromArgb(16, 185, 129), 104);
            btnStartServer.Click += (s, e) => StartAllServices();

            btnStopServer = CreateStyledButton("⏹ 停止服务", Color.FromArgb(239, 68, 68), 104);
            btnStopServer.Click += (s, e) => StopAllServices();

            btnRestartServer = CreateStyledButton("⚡ 重启主服务", Color.FromArgb(245, 158, 11), 116);
            btnRestartServer.Click += (s, e) => RestartAppService();

            Button btnPanel = CreateStyledButton("🌐 管理面板", Color.FromArgb(0, 114, 255), 110);
            btnPanel.Click += (s, e) => OpenWebApp("http://localhost:3001");

            Button btnClient = CreateStyledButton("💬 聊天前端", Color.FromArgb(16, 137, 185), 110);
            btnClient.Click += (s, e) => OpenWebApp("http://localhost:3000");

            pnlHeaderActions.Controls.Add(btnClient);
            pnlHeaderActions.Controls.Add(btnPanel);
            pnlHeaderActions.Controls.Add(btnRestartServer);
            pnlHeaderActions.Controls.Add(btnStopServer);
            pnlHeaderActions.Controls.Add(btnStartServer);

            pnlHeader.Controls.Add(lblHeaderTitle);
            pnlHeader.Controls.Add(lblServerStatusBadge);
            pnlHeader.Controls.Add(lblPorts);
            pnlHeader.Controls.Add(pnlHeaderActions);

            // ---------- 左侧导航 ----------
            sidebar = new Panel();
            sidebar.Dock = DockStyle.Left;
            sidebar.Width = 156;
            sidebar.BackColor = Color.FromArgb(8, 11, 19);
            sidebar.Padding = new Padding(10, 16, 10, 10);

            Label lblNav = new Label();
            lblNav.Text = "  控制台导航";
            lblNav.Font = new Font("Microsoft YaHei UI", 8f);
            lblNav.ForeColor = Color.FromArgb(71, 85, 105);
            lblNav.Dock = DockStyle.Top;
            lblNav.Height = 28;
            sidebar.Controls.Add(lblNav);

            navOverview = CreateNavButton("📊  服务总览", true);
            navLogs = CreateNavButton("📜  实时日志", false);
            navTools = CreateNavButton("🛠️  运维工具", false);
            navOverview.Click += (s, e) => SwitchView(navOverview, viewOverview);
            navLogs.Click += (s, e) => SwitchView(navLogs, viewLogs);
            navTools.Click += (s, e) => SwitchView(navTools, viewTools);
            // DockStyle.Top 后添加的在上方：倒序添加使顶部依次为 lblNav → 总览 → 日志 → 工具
            sidebar.Controls.Add(navTools);
            sidebar.Controls.Add(navLogs);
            sidebar.Controls.Add(navOverview);
            sidebar.Controls.Add(lblNav);

            // ---------- 视图容器 ----------
            Panel contentHost = new Panel();
            contentHost.Dock = DockStyle.Fill;
            contentHost.BackColor = Color.FromArgb(10, 14, 23);
            contentHost.Padding = new Padding(16, 14, 16, 14);

            viewOverview = BuildOverviewView();
            viewLogs = BuildLogsView();
            viewTools = BuildToolsView();

            contentHost.Controls.Add(viewOverview);
            contentHost.Controls.Add(viewLogs);
            contentHost.Controls.Add(viewTools);

            this.Controls.Add(contentHost);
            this.Controls.Add(sidebar);
            this.Controls.Add(pnlHeader);
            SwitchView(navOverview, viewOverview);

            this.FormClosing += (s, e) => {
                if (!isExiting)
                {
                    e.Cancel = true;
                    this.Hide();
                    trayIcon.ShowBalloonTip(2000, "Linkey 服务端守护中", "控制台已最小化至系统托盘，双击图标可随时呼出。", ToolTipIcon.Info);
                }
            };
        }

        private Button CreateNavButton(string text, bool active)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Dock = DockStyle.Top;
            btn.Height = 46;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(20, 30, 52);
            btn.BackColor = active ? Color.FromArgb(18, 34, 58) : Color.FromArgb(8, 11, 19);
            btn.ForeColor = active ? Color.FromArgb(0, 242, 254) : Color.FromArgb(160, 174, 192);
            btn.TextAlign = ContentAlignment.MiddleLeft;
            btn.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            btn.Cursor = Cursors.Hand;
            btn.Margin = new Padding(0, 4, 0, 0);
            btn.Padding = new Padding(8, 0, 0, 0);
            return btn;
        }

        private void SwitchView(Button activeNav, Panel activeView)
        {
            navOverview.BackColor = navOverview == activeNav ? Color.FromArgb(18, 34, 58) : Color.FromArgb(8, 11, 19);
            navOverview.ForeColor = navOverview == activeNav ? Color.FromArgb(0, 242, 254) : Color.FromArgb(160, 174, 192);
            navLogs.BackColor = navLogs == activeNav ? Color.FromArgb(18, 34, 58) : Color.FromArgb(8, 11, 19);
            navLogs.ForeColor = navLogs == activeNav ? Color.FromArgb(0, 242, 254) : Color.FromArgb(160, 174, 192);
            navTools.BackColor = navTools == activeNav ? Color.FromArgb(18, 34, 58) : Color.FromArgb(8, 11, 19);
            navTools.ForeColor = navTools == activeNav ? Color.FromArgb(0, 242, 254) : Color.FromArgb(160, 174, 192);

            viewOverview.Visible = viewOverview == activeView;
            viewLogs.Visible = viewLogs == activeView;
            viewTools.Visible = viewTools == activeView;
        }

        // ---------- 视图 1：服务总览 ----------
        private Panel BuildOverviewView()
        {
            Panel view = new Panel();
            view.Dock = DockStyle.Fill;
            view.BackColor = Color.FromArgb(10, 14, 23);

            TableLayoutPanel grid = new TableLayoutPanel();
            grid.Dock = DockStyle.Fill;
            grid.ColumnCount = 2;
            grid.RowCount = 2;
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            grid.CellBorderStyle = TableLayoutPanelCellBorderStyle.None;

            // 卡片 1：主服务 (3000)
            Panel card1 = CreateStatCard(Color.FromArgb(16, 185, 129), "🖥️ 主服务 (端口 3000)", out valAppState, out subAppState);
            Button btnQuickClient = CreateStyledButton("打开聊天前端", Color.FromArgb(16, 185, 129), 120);
            btnQuickClient.Height = 30;
            btnQuickClient.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            btnQuickClient.Location = new Point(16, 148);
            btnQuickClient.Click += (s, e) => OpenWebApp("http://localhost:3000");
            card1.Controls.Add(btnQuickClient);

            // 卡片 2：守护进程 (3001)
            Panel card2 = CreateStatCard(Color.FromArgb(0, 114, 255), "🛡️ 守护进程 (端口 3001)", out valDaemonState, out subDaemonState);
            Button btnQuickPanel = CreateStyledButton("打开管理面板", Color.FromArgb(0, 114, 255), 120);
            btnQuickPanel.Height = 30;
            btnQuickPanel.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            btnQuickPanel.Location = new Point(16, 148);
            btnQuickPanel.Click += (s, e) => OpenWebApp("http://localhost:3001");
            card2.Controls.Add(btnQuickPanel);

            // 卡片 3：公网隧道
            Panel card3 = CreateStatCard(Color.FromArgb(245, 158, 11), "🌍 公网联机隧道", out valTunnelState, out subTunnelState);
            Button btnTunnel = CreateStyledButton("开启外网联机", Color.FromArgb(245, 158, 11), 120);
            btnTunnel.Height = 30;
            btnTunnel.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            btnTunnel.Location = new Point(16, 148);
            btnTunnel.Click += (s, e) => {
                string cmdPath = Path.Combine(appRootDir, "开启外网联机.cmd");
                if (File.Exists(cmdPath)) Process.Start(cmdPath);
                else MessageBox.Show("未找到 开启外网联机.cmd", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            };
            card3.Controls.Add(btnTunnel);

            // 卡片 4：数据资产
            Panel card4 = CreateStatCard(Color.FromArgb(139, 92, 246), "💾 数据与分发", out valDataState, out subDataState);
            Button btnDist = CreateStyledButton("打开 dist 目录", Color.FromArgb(139, 92, 246), 120);
            btnDist.Height = 30;
            btnDist.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            btnDist.Location = new Point(16, 148);
            btnDist.Click += (s, e) => { string d = Path.Combine(appRootDir, "dist"); Directory.CreateDirectory(d); Process.Start("explorer.exe", d); };
            card4.Controls.Add(btnDist);

            grid.Controls.Add(card1, 0, 0);
            grid.Controls.Add(card2, 1, 0);
            grid.Controls.Add(card3, 0, 1);
            grid.Controls.Add(card4, 1, 1);

            view.Controls.Add(grid);
            return view;
        }

        private Panel CreateStatCard(Color accent, string title, out Label bigValue, out Label subValue)
        {
            Panel card = new Panel();
            card.Dock = DockStyle.Fill;
            card.BackColor = Color.FromArgb(16, 23, 38);
            card.Margin = new Padding(8);
            card.Padding = new Padding(4);

            Panel accentBar = new Panel();
            accentBar.Dock = DockStyle.Left;
            accentBar.Width = 4;
            accentBar.BackColor = accent;
            card.Controls.Add(accentBar);

            Label lblTitle = new Label();
            lblTitle.Text = title;
            lblTitle.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(148, 163, 184);
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(18, 14);
            card.Controls.Add(lblTitle);

            bigValue = new Label();
            bigValue.Text = "检测中...";
            bigValue.Font = new Font("Microsoft YaHei UI", 17f, FontStyle.Bold);
            bigValue.ForeColor = accent;
            bigValue.AutoSize = true;
            bigValue.Location = new Point(16, 48);
            card.Controls.Add(bigValue);

            subValue = new Label();
            subValue.Text = "";
            subValue.Font = new Font("Microsoft YaHei UI", 8.5f);
            subValue.ForeColor = Color.FromArgb(100, 116, 139);
            subValue.AutoSize = false;
            subValue.Size = new Size(430, 46);
            subValue.Location = new Point(18, 96);
            card.Controls.Add(subValue);

            return card;
        }

        // ---------- 视图 2：实时日志 ----------
        private Panel BuildLogsView()
        {
            Panel view = new Panel();
            view.Dock = DockStyle.Fill;
            view.BackColor = Color.FromArgb(10, 14, 23);

            Panel pnlLogTools = new Panel();
            pnlLogTools.Dock = DockStyle.Top;
            pnlLogTools.Height = 46;
            pnlLogTools.BackColor = Color.FromArgb(10, 14, 23);
            pnlLogTools.Padding = new Padding(0, 0, 0, 8);

            Button btnClearLogs = CreateStyledButton("🧹 清空输出", Color.FromArgb(71, 85, 105), 110);
            btnClearLogs.Height = 30;
            btnClearLogs.Click += (s, e) => txtLiveLogs.Clear();

            Label lblLogTip = new Label();
            lblLogTip.Text = "实时捕获 Node.js 守护进程与通讯服务的标准输出流";
            lblLogTip.ForeColor = Color.FromArgb(100, 116, 139);
            lblLogTip.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblLogTip.AutoSize = true;
            lblLogTip.Location = new Point(2, 12);

            FlowLayoutPanel pnlLogBtns = new FlowLayoutPanel();
            pnlLogBtns.Dock = DockStyle.Right;
            pnlLogBtns.FlowDirection = FlowDirection.RightToLeft;
            pnlLogBtns.AutoSize = true;
            pnlLogBtns.Controls.Add(btnClearLogs);

            pnlLogTools.Controls.Add(lblLogTip);
            pnlLogTools.Controls.Add(pnlLogBtns);

            txtLiveLogs = new TextBox();
            txtLiveLogs.Dock = DockStyle.Fill;
            txtLiveLogs.Multiline = true;
            txtLiveLogs.ReadOnly = true;
            txtLiveLogs.ScrollBars = ScrollBars.Both;
            txtLiveLogs.BackColor = Color.FromArgb(6, 9, 15);
            txtLiveLogs.ForeColor = Color.FromArgb(226, 232, 240);
            txtLiveLogs.Font = new Font("Consolas", 10.0f);
            txtLiveLogs.WordWrap = false;
            txtLiveLogs.BorderStyle = BorderStyle.FixedSingle;

            view.Controls.Add(txtLiveLogs);
            view.Controls.Add(pnlLogTools);
            return view;
        }

        // ---------- 视图 3：运维工具 ----------
        private Panel BuildToolsView()
        {
            Panel view = new Panel();
            view.Dock = DockStyle.Fill;
            view.BackColor = Color.FromArgb(10, 14, 23);

            FlowLayoutPanel grid = new FlowLayoutPanel();
            grid.Dock = DockStyle.Fill;
            grid.AutoScroll = true;

            migrationCard = CreateToolCard("📦 完整数据迁移", "保留账号、聊天记录、图片和文件，导出到新服务器", ExportMigration);
            grid.Controls.Add(migrationCard);

            grid.Controls.Add(CreateToolCard("📁 打开项目根目录", "查看项目源文件与配置", () => Process.Start("explorer.exe", appRootDir)));
            grid.Controls.Add(CreateToolCard("📂 上传资源目录", "查看用户上传的图片与附件", () => {
                string uploads = Path.Combine(appRootDir, "public", "uploads");
                Directory.CreateDirectory(uploads);
                Process.Start("explorer.exe", uploads);
            }));
            grid.Controls.Add(CreateToolCard("🌍 开启广域网外网联机", "一键启动 Cloudflare Tunnel，公网朋友随时联机", () => {
                string cmdPath = Path.Combine(appRootDir, "开启外网联机.cmd");
                if (File.Exists(cmdPath)) Process.Start(cmdPath);
                else MessageBox.Show("未找到 开启外网联机.cmd", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }));
            grid.Controls.Add(CreateToolCard("📦 客户端安装包 (dist)", "电脑安装包与安卓 APK 分发文件", () => {
                string dist = Path.Combine(appRootDir, "dist");
                Directory.CreateDirectory(dist);
                Process.Start("explorer.exe", dist);
            }));
            grid.Controls.Add(CreateToolCard("💾 数据备份目录", "SQLite 在线热备份数据库文件", () => {
                string backups = Path.Combine(appRootDir, "backups");
                Directory.CreateDirectory(backups);
                Process.Start("explorer.exe", backups);
            }));
            grid.Controls.Add(CreateToolCard("📱 网页下载目录", "局域网朋友可从网页直链下载的资源", () => {
                string downloads = Path.Combine(appRootDir, "public", "downloads");
                Directory.CreateDirectory(downloads);
                Process.Start("explorer.exe", downloads);
            }));
            grid.Controls.Add(CreateToolCard("📜 运行日志文件夹", "每日滚动的详细错误与审计日志", () => {
                string logs = Path.Combine(appRootDir, "logs");
                Directory.CreateDirectory(logs);
                Process.Start("explorer.exe", logs);
            }));
            grid.Controls.Add(CreateToolCard("🖥️ 打开运维 Web 面板", "完整的账号/聊天记录/备份管理控制台", () => OpenWebApp("http://localhost:3001")));

            view.Controls.Add(grid);
            return view;
        }

        private static string JsonText(Dictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) ? value as string : null;
        }

        internal static string ResolveMigrationArchive(string root, Dictionary<string, object> data)
        {
            string name = JsonText(data, "fileName");
            if (string.IsNullOrEmpty(name) || !Regex.IsMatch(name, @"\ALinkey-完整数据迁移包-[0-9]{8}-[0-9]{6}\.zip\z") ||
                JsonText(data, "relativePath") != "dist/" + name)
                throw new InvalidDataException("服务器返回的迁移包路径无效。");
            return Path.Combine(Path.GetFullPath(root), "dist", name);
        }

        private Dictionary<string, object> MigrationRequest(string method, string endpoint)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3001/api/admin/migration/" + endpoint);
            request.Method = method;
            request.Headers["X-Linkey-Local"] = "1";
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = method == "POST" ? 7200000 : 15000;
            request.ReadWriteTimeout = request.Timeout;
            if (method == "POST") request.ContentLength = 0;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 1048576;
                return serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
        }

        private void ExportMigration()
        {
            if (migrationBusy) return;
            if (MessageBox.Show("迁移包包含所有账号、聊天记录、图片和文件。请妥善保管，仅交给可信的服务器管理员。\n\n导出期间请尽量暂停发送消息，最终迁移前再导出一次。现在开始导出？",
                "完整数据迁移", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            migrationBusy = true;
            migrationCard.Enabled = false;
            AppendLog("正在导出完整数据迁移包，请等待完成。");
            ThreadPool.QueueUserWorkItem(delegate {
                Dictionary<string, object> result = null;
                string message = null;
                try
                {
                    Dictionary<string, object> response = MigrationRequest("POST", "export");
                    object value;
                    if (!response.TryGetValue("success", out value) || !(value is bool) || !(bool)value ||
                        !response.TryGetValue("migration", out value) || (result = value as Dictionary<string, object>) == null)
                        throw new InvalidDataException("迁移服务未返回有效的完成结果。");
                }
                catch (WebException error)
                {
                    HttpWebResponse failedResponse = error.Response as HttpWebResponse;
                    bool conflict = failedResponse != null && failedResponse.StatusCode == HttpStatusCode.Conflict;
                    if (failedResponse != null) failedResponse.Dispose();
                    // Never retry POST: a timed-out request may still be creating the archive.
                    try
                    {
                        Dictionary<string, object> status = MigrationRequest("GET", "status");
                        string state = JsonText(status, "state");
                        if (state == "completed") result = status;
                        else if (state == "running") message = "服务器正在导出迁移包，请到 Web 面板的备份页面查看进度。";
                        else message = conflict ? "已有迁移任务，请到 Web 面板查看结果。" : "导出请求未完成，请到 Web 面板检查迁移状态后再操作。";
                    }
                    catch { message = "暂时无法确认导出结果。请检查管理服务，并在 Web 面板查看迁移状态，避免重复导出。"; }
                }
                catch (Exception error) { message = "导出失败：" + error.Message; }
                string archive = null;
                if (result != null)
                {
                    try
                    {
                        archive = ResolveMigrationArchive(appRootDir, result);
                        if (!File.Exists(archive)) throw new FileNotFoundException("未找到导出的迁移包，请在服务器的 dist 目录检查。");
                        message = "完整数据迁移包已导出：\n" + archive + "\n\n将整个压缩包复制到新电脑并解压，按安装说明准备环境后启动。";
                        object warnings;
                        if (result.TryGetValue("cleanupWarnings", out warnings) && warnings is object[] && ((object[])warnings).Length > 0)
                            message += "\n\n注意：服务器未能清理部分临时文件，请在 Web 面板查看警告。迁移包本身已经生成。";
                    }
                    catch (Exception error) { archive = null; message = error.Message; }
                }
                if (IsDisposed || !IsHandleCreated) return;
                try { BeginInvoke((MethodInvoker)delegate {
                    migrationBusy = false;
                    migrationCard.Enabled = true;
                    AppendLog(message);
                    MessageBox.Show(message, "完整数据迁移", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    if (archive != null)
                    {
                        try
                        {
                            ProcessStartInfo explorer = new ProcessStartInfo();
                            explorer.FileName = "explorer.exe";
                            explorer.Arguments = "/select,\"" + archive + "\"";
                            explorer.UseShellExecute = true;
                            Process.Start(explorer);
                        }
                        catch (Exception error) { AppendLog("打开迁移包目录失败：" + error.Message); }
                    }
                }); } catch (InvalidOperationException) { }
            });
        }

        private Button CreateStyledButton(string text, Color bg, int width)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.BackColor = bg;
            btn.ForeColor = Color.White;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.Width = width;
            btn.Height = 34;
            btn.Font = new Font("Microsoft YaHei UI", 9.0f, FontStyle.Bold);
            btn.Cursor = Cursors.Hand;
            btn.Margin = new Padding(4, 0, 4, 0);
            return btn;
        }

        private Panel CreateToolCard(string title, string desc, Action onClick)
        {
            Panel p = new Panel();
            p.Size = new Size(340, 104);
            p.BackColor = Color.FromArgb(16, 23, 38);
            p.Padding = new Padding(16);
            p.Margin = new Padding(8);
            p.Cursor = Cursors.Hand;

            Label lblT = new Label();
            lblT.Text = title;
            lblT.Font = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
            lblT.ForeColor = Color.FromArgb(0, 242, 254);
            lblT.AutoSize = true;
            lblT.Location = new Point(14, 14);
            p.Controls.Add(lblT);

            Label lblD = new Label();
            lblD.Text = desc;
            lblD.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblD.ForeColor = Color.FromArgb(148, 163, 184);
            lblD.AutoSize = false;
            lblD.Size = new Size(290, 36);
            lblD.Location = new Point(16, 44);
            p.Controls.Add(lblD);

            Button btnAct = CreateStyledButton("立即前往", Color.FromArgb(0, 114, 255), 90);
            btnAct.Height = 28;
            btnAct.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            btnAct.Location = new Point(230, 68);
            btnAct.Click += (s, e) => onClick();
            p.Controls.Add(btnAct);

            p.Click += (s, e) => onClick();
            lblT.Click += (s, e) => onClick();
            lblD.Click += (s, e) => onClick();

            return p;
        }

        // 用 Edge/Chrome App 窗口打开 Web 面板（替代旧版内嵌 IE 浏览器控件）
        private void OpenWebApp(string url)
        {
            string browser = FindModernBrowser();
            string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FastQQ", "ManagerWeb");
            Directory.CreateDirectory(dataDir);

            if (!string.IsNullOrEmpty(browser))
            {
                string args = string.Format("--app=\"{0}\" --window-size=1300,880 --user-data-dir=\"{1}\" --disable-features=Translate", url, dataDir);
                try
                {
                    Process.Start(new ProcessStartInfo(browser, args) { UseShellExecute = false });
                    return;
                }
                catch {}
            }
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }

        private string FindModernBrowser()
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
            catch {}

            return null;
        }

        private void SetupTrayIcon()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("🖥️ 打开控制台主界面", null, (s, e) => { this.Show(); this.WindowState = FormWindowState.Normal; this.BringToFront(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("🌐 管理面板 (3001)", null, (s, e) => OpenWebApp("http://localhost:3001"));
            trayMenu.Items.Add("💬 用户端聊天 (3000)", null, (s, e) => OpenWebApp("http://localhost:3000"));
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("🔄 重启主服务", null, (s, e) => RestartAppService());
            trayMenu.Items.Add("⏹️ 停止所有服务", null, (s, e) => StopAllServices());
            trayMenu.Items.Add("▶️ 启动所有服务", null, (s, e) => StartAllServices());
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("❌ 彻底退出程序", null, (s, e) => {
                isExiting = true;
                StopAllServices();
                trayIcon.Visible = false;
                Application.Exit();
            });

            trayIcon = new NotifyIcon();
            trayIcon.Text = "Linkey 服务端与管理系统";
            trayIcon.ContextMenuStrip = trayMenu;
            try
            {
                trayIcon.Icon = this.Icon != null ? this.Icon : SystemIcons.Application;
            }
            catch
            {
                trayIcon.Icon = SystemIcons.Application;
            }
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => { this.Show(); this.WindowState = FormWindowState.Normal; this.BringToFront(); };
        }

        private void AutoStartServerIfStopped()
        {
            ThreadPool.QueueUserWorkItem((state) => {
                bool isRunning = IsPortOpen("127.0.0.1", 3001);
                if (!isRunning)
                {
                    this.Invoke((MethodInvoker)delegate {
                        StartAllServices();
                    });
                }
            });
        }

        private void StartAllServices()
        {
            AppendLog("[MANAGER] 正在启动 Linkey 服务端与守护进程...");
            string adminScript = Path.Combine(appRootDir, "admin", "admin.js");

            if (!File.Exists(adminScript))
            {
                AppendLog("[ERROR] 未找到 admin.js，当前工作路径: " + appRootDir);
                MessageBox.Show("未找到 admin/admin.js 文件，请确认软件位于项目根目录。", "启动错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                if (adminProcess != null && !adminProcess.HasExited)
                {
                    AppendLog("[MANAGER] 守护进程已在运行中 (PID: " + adminProcess.Id + ")");
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExecutable;
                psi.Arguments = "\"" + adminScript + "\"";
                psi.WorkingDirectory = appRootDir;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                adminProcess = new Process();
                adminProcess.StartInfo = psi;
                adminProcess.EnableRaisingEvents = true;

                adminProcess.OutputDataReceived += (s, e) => {
                    if (!string.IsNullOrEmpty(e.Data)) AppendLog(e.Data);
                };
                adminProcess.ErrorDataReceived += (s, e) => {
                    if (!string.IsNullOrEmpty(e.Data)) AppendLog("[ERR] " + e.Data);
                };

                adminProcess.Start();
                adminProcess.BeginOutputReadLine();
                adminProcess.BeginErrorReadLine();

                AppendLog("[MANAGER] 守护进程启动成功 (PID: " + adminProcess.Id + ")");
            }
            catch (Exception ex)
            {
                AppendLog("[FATAL] 启动失败: " + ex.Message);
            }
        }

        private void StopAllServices()
        {
            AppendLog("[MANAGER] 正在停止 Linkey 服务...");
            ThreadPool.QueueUserWorkItem((st) => {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3001/api/admin/shutdown");
                    req.Method = "POST";
                    req.Timeout = 1500;
                    req.Headers.Add("X-Linkey-Local", "1"); // 本机可信调用豁免头
                    using (var resp = req.GetResponse()) {}
                }
                catch {}

                Thread.Sleep(500);

                if (adminProcess != null && !adminProcess.HasExited)
                {
                    try { adminProcess.Kill(); } catch {}
                }

                this.Invoke((MethodInvoker)delegate {
                    AppendLog("[MANAGER] 所有服务已停止");
                    RefreshStatusNow();
                });
            });
        }

        private void RestartAppService()
        {
            AppendLog("[MANAGER] 正在触发主服务平滑重启...");
            ThreadPool.QueueUserWorkItem((st) => {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3001/api/admin/app/restart");
                    req.Method = "POST";
                    req.Timeout = 2000;
                    req.Headers.Add("X-Linkey-Local", "1"); // 本机可信调用豁免头
                    using (var resp = req.GetResponse()) {}
                    this.Invoke((MethodInvoker)delegate {
                        AppendLog("[MANAGER] 已发送主服务重启指令");
                    });
                }
                catch (Exception ex)
                {
                    this.Invoke((MethodInvoker)delegate {
                        AppendLog("[WARN] 重启主服务失败，正在尝试完整重新拉起: " + ex.Message);
                        StartAllServices();
                    });
                }
            });
        }

        // =====================================================================
        // 状态轮询：TCP 探测 + /healthz 指标 + 隧道地址 + 备份数量
        // =====================================================================
        private void RefreshStatusAsync()
        {
            ThreadPool.QueueUserWorkItem((st) => {
                bool isAdminUp = IsPortOpen("127.0.0.1", 3001);
                bool isAppUp = IsPortOpen("127.0.0.1", 3000);

                string healthJson = null;
                if (isAppUp) healthJson = HttpGet("http://127.0.0.1:3000/healthz", 1500);

                long uptime = ExtractNumber(healthJson, "uptime");
                long onlineUsers = ExtractNumber(healthJson, "onlineUsers");
                long wsConnections = ExtractNumber(healthJson, "connections");
                long rssKb = ExtractNumber(healthJson, "rss");

                string tunnelUrl = ReadFreshTunnelUrl();

                if (backupCountCache < 0 || (DateTime.Now - backupCountAt).TotalSeconds > 30)
                {
                    try
                    {
                        string backupsDir = Path.Combine(appRootDir, "backups");
                        if (Directory.Exists(backupsDir)) backupCountCache = Directory.GetFiles(backupsDir, "*.db").Length;
                        else backupCountCache = 0;
                        backupCountAt = DateTime.Now;
                    }
                    catch { backupCountCache = 0; }
                }

                string tunnelState, tunnelSub;
                if (!string.IsNullOrEmpty(tunnelUrl))
                {
                    tunnelState = "🌍 已开启";
                    tunnelSub = "公网地址: " + tunnelUrl;
                }
                else
                {
                    tunnelState = "⚪ 未开启";
                    tunnelSub = "点击右侧【开启外网联机】按钮，让公网朋友随时联机";
                }

                this.Invoke((MethodInvoker)delegate {
                    // 头部徽章
                    if (isAdminUp && isAppUp)
                    {
                        lblServerStatusBadge.Text = "● 全部服务运行中";
                        lblServerStatusBadge.ForeColor = Color.FromArgb(16, 185, 129);
                        btnStartServer.Enabled = false;
                        btnStopServer.Enabled = true;
                        btnRestartServer.Enabled = true;
                    }
                    else if (isAdminUp)
                    {
                        lblServerStatusBadge.Text = "● 守护在线 · 主服务未运行";
                        lblServerStatusBadge.ForeColor = Color.FromArgb(245, 158, 11);
                        btnStartServer.Enabled = true;
                        btnStopServer.Enabled = true;
                        btnRestartServer.Enabled = true;
                    }
                    else
                    {
                        lblServerStatusBadge.Text = "● 服务已停止";
                        lblServerStatusBadge.ForeColor = Color.FromArgb(239, 68, 68);
                        btnStartServer.Enabled = true;
                        btnStopServer.Enabled = false;
                        btnRestartServer.Enabled = false;
                    }

                    // 卡片 1：主服务
                    if (isAppUp)
                    {
                        valAppState.Text = "🟢 运行中";
                        string memText = rssKb > 0 ? (rssKb / 1024).ToString("0") + " MB 内存" : "";
                        subAppState.Text = string.Format("在线用户 {0} · WS 连接 {1} · {2} · 已运行 {3} 分钟",
                            onlineUsers, wsConnections, memText, uptime / 60);
                    }
                    else
                    {
                        valAppState.Text = "🔴 已停止";
                        subAppState.Text = "主服务未运行，点击【启动服务】或等待守护进程自动拉起";
                    }

                    // 卡片 2：守护进程
                    if (isAdminUp)
                    {
                        valDaemonState.Text = "🟢 守护中";
                        subDaemonState.Text = "崩溃自动拉起 (指数退避) · 每 30s 健康探活 · 每日 3:00 在线热备";
                    }
                    else
                    {
                        valDaemonState.Text = "⚪ 离线";
                        subDaemonState.Text = "守护进程未运行，启动后将自动监管主服务";
                    }

                    // 卡片 3：隧道 / 卡片 4：数据
                    valTunnelState.Text = tunnelState;
                    subTunnelState.Text = tunnelSub;
                    valDataState.Text = backupCountCache + " 份备份";
                    subDataState.Text = "数据库在线热备 (VACUUM INTO) · 安装包位于 dist/ 目录";
                });
            });
        }

        private void RefreshStatusNow()
        {
            // 立即刷新一次（不等待下个周期）
            new Thread(() => { RefreshStatusAsync(); }).Start();
        }

        private string HttpGet(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (var stream = resp.GetResponseStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch { return null; }
        }

        private static long ExtractNumber(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return 0;
            Regex r = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?[0-9.]+)");
            Match m = r.Match(json);
            if (m.Success)
            {
                long v;
                if (long.TryParse(m.Groups[1].Value, out v)) return v;
                double d;
                if (double.TryParse(m.Groups[1].Value, out d)) return (long)d;
            }
            return 0;
        }

        // 读取 public-url.json，超过 6 小时视为过期死链（与服务端逻辑一致）
        private string ReadFreshTunnelUrl()
        {
            try
            {
                string path = Path.Combine(appRootDir, "public-url.json");
                if (!File.Exists(path)) return null;
                string json = File.ReadAllText(path);
                Match urlMatch = RxTunnelUrl.Match(json);
                if (!urlMatch.Success) return null;
                Match timeMatch = RxUpdatedAt.Match(json);
                if (timeMatch.Success)
                {
                    long ms;
                    if (long.TryParse(timeMatch.Groups[1].Value, out ms))
                    {
                        long ageMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - ms;
                        if (ageMs > 6L * 3600 * 1000) return null;
                    }
                }
                return urlMatch.Groups[1].Value;
            }
            catch { return null; }
        }

        private bool IsPortOpen(string host, int port)
        {
            try
            {
                using (var client = new System.Net.Sockets.TcpClient())
                {
                    var result = client.BeginConnect(host, port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(400);
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private void AppendLog(string text)
        {
            if (this.IsDisposed) return;
            if (txtLiveLogs.InvokeRequired)
            {
                txtLiveLogs.BeginInvoke((MethodInvoker)delegate { AppendLog(text); });
                return;
            }

            string line = string.Format("[{0:HH:mm:ss}] {1}\r\n", DateTime.Now, text);
            txtLiveLogs.AppendText(line);

            if (txtLiveLogs.Lines.Length > 2000)
            {
                txtLiveLogs.Text = txtLiveLogs.Text.Substring(txtLiveLogs.Text.Length / 2);
            }
        }
    }
}
