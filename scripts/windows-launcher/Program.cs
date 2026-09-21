using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;
using System.Drawing;

namespace FastQQClient
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string currentDir = AppDomain.CurrentDomain.BaseDirectory;
            string ipFile = Path.Combine(currentDir, "server_ip.txt");
            string serverUrl = "http://localhost:3000";

            if (File.Exists(ipFile))
            {
                string ip = File.ReadAllText(ipFile).Trim();
                if (!string.IsNullOrEmpty(ip))
                {
                    serverUrl = "http://" + ip + (ip.Contains(":") ? "" : ":3000");
                }
            }

            string serverJs = Path.Combine(currentDir, "src", "server.js");
            if (File.Exists(serverJs))
            {
                StartLocalServerIfNeeded(currentDir);
            }

            LaunchAppWindow(serverUrl);
        }

        static void StartLocalServerIfNeeded(string dir)
        {
            try
            {
                using (var client = new System.Net.Sockets.TcpClient())
                {
                    try
                    {
                        client.Connect("127.0.0.1", 3000);
                        return;
                    }
                    catch { }
                }

                string nodeExe = "node";

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = "\"" + Path.Combine(dir, "src", "server.js") + "\"";
                psi.WorkingDirectory = dir;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;

                Process.Start(psi);
                System.Threading.Thread.Sleep(800);
            }
            catch { }
        }

        static void LaunchAppWindow(string url)
        {
            string edge1 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
            string edge2 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
            string chrome = @"C:\Program Files\Google\Chrome\Application\chrome.exe";

            string browser = null;
            if (File.Exists(edge1)) browser = edge1;
            else if (File.Exists(edge2)) browser = edge2;
            else if (File.Exists(chrome)) browser = chrome;

            string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Linkey", "AppData");

            if (browser != null)
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browser;
                psi.Arguments = "--user-data-dir=\"" + profileDir + "\" --app=" + url + " --window-size=1120,760 --no-first-run --no-default-browser-check";
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            else
            {
                Process.Start(url);
            }
        }
    }
}
