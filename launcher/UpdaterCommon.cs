using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace NativeThreeBridge.Updates;

// launcher.json next to the EXEs: which game folder and GitHub repositories
// the launcher installs (defaults: Kuningriigid in game2).
internal static class Config
{
    internal static string GameFolder = "game2";
    internal static string GameRepository = "orogdor/Kuningriigid";
    internal static string GameBranch = "main";
    internal static string EngineRepository = "orogdor/NativeThreeBridge";
    internal static string GameNewsLabel = "Mäng";

    internal static void Load()
    {
        string path = Path.Combine(Common.Root, "launcher.json");
        if (!File.Exists(path)) return;
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement r = doc.RootElement;
        string Get(string key, string fallback) => r.TryGetProperty(key, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : fallback;
        GameFolder = Get("gameFolder", GameFolder);
        GameRepository = Get("gameRepository", GameRepository);
        GameBranch = Get("gameBranch", GameBranch);
        EngineRepository = Get("engineRepository", EngineRepository);
        if (!System.Text.RegularExpressions.Regex.IsMatch(GameFolder, @"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(GameRepository, @"^[\w.-]+/[\w.-]+$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(EngineRepository, @"^[\w.-]+/[\w.-]+$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(GameBranch, @"^[\w./-]{1,80}$"))
            throw new InvalidDataException("launcher.json has an invalid value.");
    }
}

// Launcher protocol: with --machine every report is one UTF-8 line on stdout
// (PROGRESS <permille>\t<text>, DONE\t<text>, ERROR\t<text>, ...).
internal static class Out
{
    internal static bool Machine;
    private static readonly object Gate = new();
    internal static void Line(string text)
    {
        lock (Gate) { Console.Out.Write(text.Replace('\r', ' ').Replace('\n', ' ') + "\n"); Console.Out.Flush(); }
    }
    internal static void Progress(long done, long total, string text)
    {
        if (Machine) Line($"PROGRESS {(total > 0 ? Math.Clamp(done * 1000 / total, 0, 1000) : -1)}\t{text}");
    }
    internal static void Say(string text)
    {
        if (Machine) Line("STEP\t" + text); else Console.WriteLine(text);
    }
}

internal static class Common
{
    internal static readonly string Root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly HttpClient Http = new(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate })
    { Timeout = TimeSpan.FromMinutes(5) };
    static Common()
    {
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("NativeThreeBridge-Updater/0.36");
        // CI: a token lifts GitHub's anonymous rate limit (60 API calls per hour).
        string? token = Environment.GetEnvironmentVariable("NTB_GITHUB_TOKEN");
        if (!string.IsNullOrWhiteSpace(token)) Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    internal static async Task<JsonDocument> GetJson(string url)
    {
        return JsonDocument.Parse(await Download(url, 32_000_000));
    }

    internal static async Task<byte[]> Download(string url, long maxBytes, Action<long>? progress = null)
    {
        using HttpResponseMessage response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidDataException("File exceeds download limit: " + url);
        await using Stream input = await response.Content.ReadAsStreamAsync();
        using MemoryStream data = new();
        byte[] buffer = new byte[65536];
        while (true)
        {
            int count = await input.ReadAsync(buffer);
            if (count == 0) break;
            if (data.Length + count > maxBytes) throw new InvalidDataException("File exceeds download limit: " + url);
            data.Write(buffer, 0, count);
            progress?.Invoke(data.Length);
        }
        return data.ToArray();
    }

    // Streams a large download to disk; progress(doneBytes, contentLength or -1).
    internal static async Task DownloadToFile(string url, string path, long maxBytes, Action<long, long> progress)
    {
        using HttpResponseMessage response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        long total = response.Content.Headers.ContentLength ?? -1;
        if (total > maxBytes) throw new InvalidDataException("File exceeds download limit: " + url);
        await using Stream input = await response.Content.ReadAsStreamAsync();
        await using FileStream output = new(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
        byte[] buffer = new byte[1 << 20];
        long done = 0, lastReport = -1;
        progress(0, total);
        while (true)
        {
            int count = await input.ReadAsync(buffer);
            if (count == 0) break;
            done += count;
            if (done > maxBytes) throw new InvalidDataException("File exceeds download limit: " + url);
            await output.WriteAsync(buffer.AsMemory(0, count));
            if (done - lastReport >= 512 * 1024) { progress(done, total); lastReport = done; }
        }
        progress(done, total);
    }

    internal static string Sha256(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
    internal static string Sha256File(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
    internal static bool HashValid(string hash, int length) => hash.Length == length && hash.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static void CheckRelative(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 240 || path.StartsWith('/') || path.StartsWith('\\') || path.Contains('\\') || path.Contains(':'))
            throw new InvalidDataException("Unsafe repository path: " + path);
        foreach (string part in path.Split('/'))
            if (part is "" or "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.Any(c => c < 32 || "<>\"|?*".Contains(c)) ||
                new[] { "CON", "PRN", "AUX", "NUL", "COM1", "LPT1" }.Contains(Path.GetFileNameWithoutExtension(part).ToUpperInvariant()))
                throw new InvalidDataException("Unsafe repository path: " + path);
        if (path.Equals(".native-three-game-manifest.json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Reserved repository path.");
    }

    internal static string SafePath(string root, string relative)
    {
        CheckRelative(relative);
        string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Path escapes game directory.");
        return full;
    }

    internal static void RejectLinks(string root)
    {
        if (!Directory.Exists(root)) return;
        Stack<string> pending = new();
        pending.Push(root);
        while (pending.Count != 0)
        {
            string directory = pending.Pop();
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Symbolic links and junctions are not allowed: " + directory);
            foreach (string path in Directory.EnumerateFileSystemEntries(directory))
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Symbolic links and junctions are not allowed: " + path);
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(path);
            }
        }
    }

    internal static void CopyTree(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        if (!Directory.Exists(source)) return;
        RejectLinks(source);
        foreach (string directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        foreach (string file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(destination, Path.GetRelativePath(source, file)));
    }

    internal static void DeleteTree(string path)
    {
        if (!Directory.Exists(path)) return;
        RejectLinks(path);
        Directory.Delete(path, true);
    }

    internal static string EncodePath(string path) => string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
}

internal sealed class ProgressMeter(string label)
{
    // "Kuningriigid: 123 / 550 MB" (total unknown -> "123 MB alla laaditud").
    internal static void Bytes(string label, long done, long total)
    {
        string text = total > 0 ? $"{label}: {done / 1_000_000} / {total / 1_000_000} MB ({Percent(done, total)}%)"
                                : $"{label}: {done / 1_000_000} MB alla laaditud";
        if (Out.Machine) { Out.Progress(done, total, text); return; }
        Console.Write("\r" + text.PadRight(60));
        try { Console.Title = text; } catch { }
    }
    // "Kuningriigid: 120 / 2228 faili, 30 / 550 MB"
    internal static void Files(string label, int done, int total, long doneBytes = -1, long totalBytes = -1)
    {
        string text = $"{label}: {done} / {total} faili" + (totalBytes > 0 ? $", {doneBytes / 1_000_000} / {totalBytes / 1_000_000} MB" : "");
        if (Out.Machine) { Out.Progress(totalBytes > 0 ? doneBytes : done, totalBytes > 0 ? totalBytes : total, text); return; }
        Console.Write("\r" + text.PadRight(60));
        try { Console.Title = text; } catch { }
    }

    private int lastPercent = -1;
    internal static int Percent(long completed, long total) =>
        total <= 0 ? 100 : (int)Math.Clamp(completed * 100 / total, 0, 100);
    internal void Report(long completed, long total)
    {
        int percent = Percent(completed, total);
        if (percent == lastPercent) return;
        lastPercent = percent;
        if (Out.Machine) { Out.Progress(completed, total, $"{label}: {completed / 1_000_000} / {total / 1_000_000} MB"); return; }
        Console.Write($"\r{label}: {percent,3}%");
        try { Console.Title = $"{label}: {percent}%"; } catch { }
        if (percent == 100) Console.WriteLine();
    }
}
