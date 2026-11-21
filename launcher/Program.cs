using System.Text;
using NativeThreeBridge.Updates;

// NativeThree-Updater.exe: the update helper of Launcher.exe.
//   local          installed game name, versions and picture (no network)
//   status         latest engine release and game commit on GitHub + news
//   update-engine  install the newest stable engine (Launcher.exe included)
//   update-game    install the newest game commit into the game folder
//   cleanup        remove EXEs the launcher replaced (Game2.exe, Update*.exe)
// --machine: one line per report for Launcher.exe (see Out).
internal static class Program
{
    private static int Main(string[] args)
    {
        List<string> list = args.ToList();
        Out.Machine = list.Remove("--machine");
        if (Out.Machine) Console.OutputEncoding = new UTF8Encoding(false);
        string command = list.FirstOrDefault() ?? "";
        try
        {
            Config.Load();
            switch (command)
            {
                case "--self-test":
                    UpdateEngine.SelfTest(); GameUpdater.SelfTest(); LauncherInfo.SelfTest();
                    return 0;
                case "local":
                    LauncherInfo.Local();
                    return 0;
                case "status":
                    LauncherInfo.Status().GetAwaiter().GetResult();
                    Out.Line("DONE\tok");
                    return 0;
                case "update-engine":
                {
                    string message = UpdateEngine.Update().GetAwaiter().GetResult();
                    Log(message);
                    if (UpdateEngine.LauncherReplaced) Out.Line("RESTART");
                    Out.Line("DONE\t" + message);
                    return 0;
                }
                case "update-game":
                {
                    string message = GameUpdater.Update().GetAwaiter().GetResult();
                    Log(message);
                    Out.Line("DONE\t" + message);
                    return 0;
                }
                case "cleanup":
                    foreach (string old in new[] { "Game2.exe", "UpdateEngine.exe", "UpdateKuningriigid.exe" })
                    {
                        try { string path = Path.Combine(Common.Root, old); if (File.Exists(path)) File.Delete(path); } catch (Exception) { }
                    }
                    Out.Line("DONE\tok");
                    return 0;
                default:
                    throw new InvalidOperationException("Käivita mängu Launcher.exe (see programm on selle abiline).");
            }
        }
        catch (Exception ex)
        {
            string message = ex.GetBaseException().Message;
            Log("ERROR: " + message);
            Out.Line("ERROR\t" + message);
            if (!Out.Machine) Console.Error.WriteLine(message);
            return 1;
        }
    }

    private static void Log(string message)
    {
        try { File.AppendAllText(Path.Combine(Common.Root, "NativeThree-Updater.log"), $"{DateTimeOffset.UtcNow:u} {message.Replace('\n', ' ')}{Environment.NewLine}"); }
        catch (Exception) { }
    }
}
