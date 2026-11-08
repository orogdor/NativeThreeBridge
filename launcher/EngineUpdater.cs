using System.Text.Json;
using NativeThreeBridge.Updates;

internal sealed record EngineManifest(string Tag, string Sha256, long Size);

internal static class EngineUpdater
{
    private const string Repository = "orogdor/NativeThreeBridge";
    private const string AssetName = "NativeThree-Game.exe";
    private const string ManifestName = "engine-update-v1.json";

    private static (int major, int minor, int patch, int test) ParseVersion(string tag)
    {
        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(tag,
            @"^v(\d+)\.(\d+)\.(\d+)(?:-test\.(\d+))?$");
        if (!m.Success) throw new InvalidDataException("Unsupported engine release tag: " + tag);
        return (int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value),
            m.Groups[4].Success ? int.Parse(m.Groups[4].Value) : int.MaxValue);
    }

    private static bool Newer(string candidate, string installed)
    {
        var a = ParseVersion(candidate);
        var b = ParseVersion(installed);
        return a.major != b.major ? a.major > b.major :
               a.minor != b.minor ? a.minor > b.minor :
               a.patch != b.patch ? a.patch > b.patch : a.test > b.test;
    }

    private static async Task<string> Update()
    {
        string gameExe = Path.Combine(Common.Root, AssetName);
        string staged = gameExe + ".new";
        string backup = gameExe + ".previous";
        string versionFile = Path.Combine(Common.Root, "engine-version.txt");
        if (!File.Exists(gameExe) && File.Exists(backup)) File.Move(backup, gameExe);
        string installed = File.Exists(versionFile) ? File.ReadAllText(versionFile).Trim() : "v0.26.0";
        ParseVersion(installed);
        using JsonDocument releases = await Common.GetJson($"https://api.github.com/repos/{Repository}/releases?per_page=20");
        foreach (JsonElement release in releases.RootElement.EnumerateArray())
        {
            if (release.GetProperty("draft").GetBoolean()) continue;
            string tag = release.GetProperty("tag_name").GetString() ?? "";
            try { if (!Newer(tag, installed)) continue; }
            catch (InvalidDataException) { continue; }
            string? manifestUrl = null, exeUrl = null;
            foreach (JsonElement asset in release.GetProperty("assets").EnumerateArray())
            {
                string name = asset.GetProperty("name").GetString() ?? "";
                string url = asset.GetProperty("browser_download_url").GetString() ?? "";
                string prefix = $"https://github.com/{Repository}/releases/download/{Uri.EscapeDataString(tag)}/";
                if (!url.StartsWith(prefix, StringComparison.Ordinal)) continue;
                if (name == ManifestName) manifestUrl = url;
                if (name == AssetName) exeUrl = url;
            }
            if (manifestUrl is null || exeUrl is null) continue;
            byte[] manifestBytes = await Common.Download(manifestUrl, 4096);
            EngineManifest manifest = JsonSerializer.Deserialize<EngineManifest>(manifestBytes,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidDataException("Invalid engine update manifest.");
            if (manifest.Tag != tag || !Common.HashValid(manifest.Sha256, 64) || manifest.Size is < 2048 or > 200_000_000)
                throw new InvalidDataException("Engine update manifest does not match the GitHub release.");
            byte[] exe = await Common.Download(exeUrl, manifest.Size);
            if (exe.LongLength != manifest.Size || Common.Sha256(exe) != manifest.Sha256)
                throw new InvalidDataException("Engine EXE failed SHA-256 verification. Installation was not changed.");
            // The engine update is confined to the root EXE and its version marker.
            // The game/ directory and its rollback snapshot are never opened here.
            if (File.Exists(staged)) File.Delete(staged);
            File.WriteAllBytes(staged, exe);
            if (File.Exists(backup)) File.Delete(backup);
            if (File.Exists(gameExe)) File.Move(gameExe, backup);
            try
            {
                File.Move(staged, gameExe);
                File.WriteAllText(versionFile, tag);
            }
            catch
            {
                if (File.Exists(gameExe)) File.Delete(gameExe);
                if (File.Exists(backup)) File.Move(backup, gameExe);
                throw;
            }
            return $"NativeThreeBridge engine updated to {tag}. Previous EXE is in {AssetName}.previous. game/ was not changed. Run NativeThree-Game.exe separately when ready.";
        }
        return $"No newer compatible engine release was found. Installed: {installed}. game/ was not changed.";
    }

    private static void SelfTest()
    {
        if (!Newer("v0.27.0-test.1", "v0.26.0") || Newer("v0.26.0", "v0.27.0-test.1") ||
            !Newer("v0.27.0", "v0.27.0-test.1")) throw new Exception("Version ordering failed.");
    }

    private static int Main(string[] args) => Common.Run("Engine-Updater", args, Update, SelfTest);
}
