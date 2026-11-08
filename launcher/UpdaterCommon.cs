using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace NativeThreeBridge.Updates;

internal static class Common
{
    internal static readonly string Root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly HttpClient Http = new(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate })
    { Timeout = TimeSpan.FromMinutes(5) };
    static Common() => Http.DefaultRequestHeaders.UserAgent.ParseAdd("NativeThreeBridge-Test-Updater/0.27");

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(nint window, string message, string caption, uint flags);

    internal static int Run(string name, string[] args, Func<Task<string>> action, Action selfTest)
    {
        try
        {
            if (args.SequenceEqual(["--self-test"])) { selfTest(); return 0; }
            if (args.Length != 0) throw new InvalidOperationException("Unknown option. Run the updater without arguments.");
            Console.WriteLine(name + ": checking GitHub...");
            string message = action().GetAwaiter().GetResult();
            Console.WriteLine(message);
            File.AppendAllText(Path.Combine(Root, name + ".log"), $"{DateTimeOffset.UtcNow:u} {message}{Environment.NewLine}");
            MessageBoxW(0, message, name, 0x40);
            return 0;
        }
        catch (Exception ex)
        {
            string message = ex.GetBaseException().Message;
            Console.Error.WriteLine("Update failed: " + message);
            try { File.AppendAllText(Path.Combine(Root, name + ".log"), $"{DateTimeOffset.UtcNow:u} ERROR: {message}{Environment.NewLine}"); } catch { }
            if (Environment.GetEnvironmentVariable("CI") is null) MessageBoxW(0, message, name, 0x10);
            return 1;
        }
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
    private int lastPercent = -1;
    internal static int Percent(long completed, long total) =>
        total <= 0 ? 100 : (int)Math.Clamp(completed * 100 / total, 0, 100);
    internal void Report(long completed, long total)
    {
        int percent = Percent(completed, total);
        if (percent == lastPercent) return;
        lastPercent = percent;
        Console.Write($"\r{label}: {percent,3}%");
        try { Console.Title = $"{label}: {percent}%"; } catch { }
        if (percent == 100) Console.WriteLine();
    }
}
