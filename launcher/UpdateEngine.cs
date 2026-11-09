using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;
using NativeThreeBridge.Updates;

// UpdateEngine.exe: compares engine-version.txt with the latest stable
// NativeThreeBridge GitHub release and replaces only the engine files
// (NativeThree-Engine.exe, Game1/Game2 launchers, V8 runtime DLLs ...).
// game1\ and game2\ are never opened.
internal static class UpdateEngine
{
    private const string Repository = "orogdor/NativeThreeBridge";
    private const string ManifestName = "engine-update-v2.json";
    private const string VersionFile = "engine-version.txt";
    private static readonly Regex SafeName = new(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$", RegexOptions.CultureInvariant);

    internal static (int, int, int) ParseVersion(string tag)
    {
        Match m = Regex.Match(tag.Trim(), @"^v?(\d+)\.(\d+)\.(\d+)$");
        if (!m.Success) throw new InvalidDataException("Tundmatu engine'i versioon: " + tag);
        return (int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value));
    }

    internal static bool Newer(string candidate, string installed) => ParseVersion(candidate).CompareTo(ParseVersion(installed)) > 0;

    // Only flat file names that belong to the engine; never game folders or this updater.
    internal static bool EngineFile(string name)
    {
        if (!SafeName.IsMatch(name) || name.Contains("..")) return false;
        foreach (string excluded in new[] { "UpdateEngine.exe", "UpdateKuningriigid.exe", VersionFile })
            if (name.Equals(excluded, StringComparison.OrdinalIgnoreCase)) return false;
        if (name.StartsWith("game", StringComparison.OrdinalIgnoreCase))
            return name.Equals("Game1.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("Game2.exe", StringComparison.OrdinalIgnoreCase);
        return true;
    }

    private static async Task<string> Update()
    {
        string root = Common.Root;
        string versionPath = Path.Combine(root, VersionFile);
        string installed = File.Exists(versionPath) ? File.ReadAllText(versionPath).Trim() : "v0.0.0";
        ParseVersion(installed);

        using JsonDocument releaseDoc = await Common.GetJson($"https://api.github.com/repos/{Repository}/releases/latest");
        JsonElement release = releaseDoc.RootElement;
        string tag = release.GetProperty("tag_name").GetString() ?? "";
        if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean())
            throw new InvalidDataException("GitHubi viimane engine'i väljalase ei ole stabiilne.");
        if (!Newer(tag, installed)) return $"Engine on juba uusim: {installed}.\ngame1 ja game2 kaustu ei muudetud.";

        string prefix = $"https://github.com/{Repository}/releases/download/{Uri.EscapeDataString(tag)}/";
        string? manifestUrl = null;
        Dictionary<string, string> assets = new(StringComparer.Ordinal);
        foreach (JsonElement asset in release.GetProperty("assets").EnumerateArray())
        {
            string name = asset.GetProperty("name").GetString() ?? "";
            string url = asset.GetProperty("browser_download_url").GetString() ?? "";
            if (!url.StartsWith(prefix, StringComparison.Ordinal)) continue;
            if (name == ManifestName) manifestUrl = url;
            assets[name] = url;
        }
        if (manifestUrl is null) throw new InvalidDataException($"Väljalaskel {tag} puudub {ManifestName}; seda ei saa automaatselt paigaldada.");
        using JsonDocument manifestDoc = JsonDocument.Parse(await Common.Download(manifestUrl, 65536));
        JsonElement manifest = manifestDoc.RootElement;
        string package = manifest.GetProperty("package").GetString() ?? "";
        string sha = manifest.GetProperty("sha256").GetString() ?? "";
        long size = manifest.GetProperty("size").GetInt64();
        if (manifest.GetProperty("tag").GetString() != tag || !Common.HashValid(sha, 64) || size is < 4096 or > 500_000_000 ||
            !assets.TryGetValue(package, out string? packageUrl))
            throw new InvalidDataException("Engine'i uuenduse manifest ei vasta GitHubi väljalaskele.");

        Console.WriteLine($"Laen alla engine {tag} ({size / 1_000_000} MB)...");
        ProgressMeter meter = new("Engine");
        byte[] zip = await Common.Download(packageUrl, size, current => meter.Report(current, size));
        meter.Report(size, size);
        if (zip.LongLength != size || Common.Sha256(zip) != sha)
            throw new InvalidDataException("Allalaaditud engine ei läbinud SHA-256 kontrolli.");

        string stage = Path.Combine(root, "engine.next"), previous = Path.Combine(root, "engine.previous");
        Common.DeleteTree(stage);
        Directory.CreateDirectory(stage);
        List<string> files = new();
        using (ZipArchive archive = new(new MemoryStream(zip), ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue;
                if (entry.FullName.Contains('/') || entry.FullName.Contains('\\') || !EngineFile(entry.Name))
                    throw new InvalidDataException("Engine'i paketis on lubamatu fail: " + entry.FullName);
                if (entry.Length > 300_000_000) throw new InvalidDataException("Liiga suur fail: " + entry.Name);
                entry.ExtractToFile(Path.Combine(stage, entry.Name));
                files.Add(entry.Name);
            }
        }
        if (!files.Contains("NativeThree-Engine.exe", StringComparer.OrdinalIgnoreCase))
            throw new InvalidDataException("Engine'i paketis puudub NativeThree-Engine.exe.");

        // A running game keeps the engine EXE locked: refuse before moving anything.
        foreach (string name in files)
        {
            string target = Path.Combine(root, name);
            if (!File.Exists(target)) continue;
            try { using FileStream lockTest = new(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { Common.DeleteTree(stage); throw new InvalidOperationException($"{name} on kasutusel. Sulge Game1/Game2 ja proovi uuesti."); }
        }

        Common.DeleteTree(previous);
        Directory.CreateDirectory(previous);
        List<string> moved = new(), installedFiles = new();
        try
        {
            foreach (string name in files)
            {
                string target = Path.Combine(root, name);
                if (File.Exists(target)) { File.Move(target, Path.Combine(previous, name)); moved.Add(name); }
                File.Move(Path.Combine(stage, name), target);
                installedFiles.Add(name);
            }
            File.WriteAllText(versionPath, tag);
        }
        catch
        {
            foreach (string name in installedFiles) { try { File.Delete(Path.Combine(root, name)); } catch { } }
            foreach (string name in moved) { try { File.Move(Path.Combine(previous, name), Path.Combine(root, name), true); } catch { } }
            throw;
        }
        Common.DeleteTree(stage);
        return $"Engine uuendatud: {installed} → {tag} ({files.Count} faili).\nEelmine versioon on kaustas engine.previous.\ngame1 ja game2 kaustu ei muudetud.";
    }

    private static void SelfTest()
    {
        if (!Newer("v0.30.1", "v0.30.0") || Newer("v0.29.9", "v0.30.0") || !Newer("v1.0.0", "v0.99.99") || Newer("v0.30.0", "v0.30.0"))
            throw new Exception("Version ordering failed.");
        foreach (string ok in new[] { "NativeThree-Engine.exe", "v8.dll", "icudtl.dat", "Game1.exe", "Game2.exe", "README-WINDOWS.txt" })
            if (!EngineFile(ok)) throw new Exception("Engine file rejected: " + ok);
        foreach (string bad in new[] { "../x.dll", "game1", "game2.dll", "UpdateEngine.exe", "UpdateKuningriigid.exe", "engine-version.txt", ".hidden", "a b.dll" })
            if (EngineFile(bad)) throw new Exception("Unsafe engine file accepted: " + bad);
        if (ProgressMeter.Percent(50, 200) != 25) throw new Exception("Percent failed.");
    }

    private static int Main(string[] args) => Common.Run("UpdateEngine", args, Update, SelfTest);
}
