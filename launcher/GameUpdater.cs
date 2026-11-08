using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NativeThreeBridge.Updates;

internal sealed record GameFile(string GitSha, string Sha256, long Size);
internal sealed record GameState(string Repository, string Commit, Dictionary<string, GameFile> Files);

internal static class GameUpdater
{
    private const string Repository = "orogdor/Kuningriigid";
    private const string Manifest = ".native-three-game-manifest.json";
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private static string GitBlobSha(byte[] bytes)
    {
        byte[] header = Encoding.ASCII.GetBytes($"blob {bytes.Length}\0");
        byte[] blob = new byte[header.Length + bytes.Length];
        Buffer.BlockCopy(header, 0, blob, 0, header.Length);
        Buffer.BlockCopy(bytes, 0, blob, header.Length, bytes.Length);
        return Convert.ToHexString(SHA1.HashData(blob)).ToLowerInvariant();
    }

    private static GameState ReadOld(string game)
    {
        string path = Path.Combine(game, Manifest);
        if (!File.Exists(path)) return new(Repository, "", new(StringComparer.OrdinalIgnoreCase));
        GameState state = JsonSerializer.Deserialize<GameState>(File.ReadAllText(path)) ?? throw new InvalidDataException("Game manifest is invalid.");
        if (state.Repository != Repository || state.Files is null) throw new InvalidDataException("Game manifest belongs to a different repository.");
        foreach ((string relative, GameFile entry) in state.Files)
        {
            Common.CheckRelative(relative);
            if (!Common.HashValid(entry.GitSha, 40) || !Common.HashValid(entry.Sha256, 64))
                throw new InvalidDataException("Invalid checksum in old game manifest.");
        }
        return state;
    }

    private static async Task<string> Update()
    {
        string game = Path.Combine(Common.Root, "game");
        string stage = Path.Combine(Common.Root, "game.next");
        string previous = Path.Combine(Common.Root, "game.previous");
        if (!Directory.Exists(game) && Directory.Exists(previous)) Directory.Move(previous, game);
        if (Directory.Exists(stage)) Common.DeleteTree(stage);
        Common.RejectLinks(game);
        GameState old = ReadOld(game);

        using JsonDocument head = await Common.GetJson("https://api.github.com/repos/orogdor/Kuningriigid/commits/main");
        string commit = head.RootElement.GetProperty("sha").GetString() ?? "";
        if (!Common.HashValid(commit, 40)) throw new InvalidDataException("Invalid Kuningriigid commit SHA.");
        using JsonDocument tree = await Common.GetJson($"https://api.github.com/repos/orogdor/Kuningriigid/git/trees/{commit}?recursive=1");
        if (tree.RootElement.GetProperty("truncated").GetBoolean()) throw new InvalidDataException("GitHub returned a truncated repository tree; no files were changed.");

        Dictionary<string, (string sha, long size)> wanted = new(StringComparer.OrdinalIgnoreCase);
        long totalBytes = 0;
        foreach (JsonElement entry in tree.RootElement.GetProperty("tree").EnumerateArray())
        {
            if (entry.GetProperty("type").GetString() != "blob") continue;
            string relative = entry.GetProperty("path").GetString() ?? "";
            string mode = entry.GetProperty("mode").GetString() ?? "";
            if (mode is not ("100644" or "100755"))
                throw new InvalidDataException("Unsupported Git entry (symlink or submodule): " + relative);
            Common.CheckRelative(relative);
            string sha = entry.GetProperty("sha").GetString() ?? "";
            long size = entry.TryGetProperty("size", out JsonElement length) ? length.GetInt64() : -1;
            if (!Common.HashValid(sha, 40) || size < 0 || size > 128_000_000)
                throw new InvalidDataException("Invalid or oversized Git blob: " + relative);
            totalBytes += size;
            if (totalBytes > 2_000_000_000 || wanted.Count > 20000)
                throw new InvalidDataException("Repository exceeds the test updater's size limit.");
            if (!wanted.TryAdd(relative, (sha, size)))
                throw new InvalidDataException("Case-colliding paths cannot be installed on Windows: " + relative);
        }
        if (!wanted.ContainsKey("index.html")) throw new InvalidDataException("Kuningriigid index.html was not found; refusing an unexpected repository tree.");

        // Never overwrite a locally edited file that belonged to the previous snapshot.
        foreach ((string relative, GameFile oldFile) in old.Files)
        {
            string current = Common.SafePath(game, relative);
            if (File.Exists(current) && Common.Sha256File(current) != oldFile.Sha256)
                throw new InvalidOperationException($"Local game file was edited: {relative}. Save or rename it before updating.");
        }
        foreach (string relative in wanted.Keys)
            if (!old.Files.ContainsKey(relative) && File.Exists(Common.SafePath(game, relative)))
                throw new InvalidOperationException($"Unmanaged local game file would be replaced: {relative}. Move it away before updating.");
        Common.CopyTree(game, stage);
        int downloaded = 0, removed = 0;
        Dictionary<string, GameFile> nextFiles = new(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach ((string relative, (string sha, long size)) in wanted)
            {
                string target = Common.SafePath(stage, relative);
                if (old.Files.TryGetValue(relative, out GameFile? prior) && prior.GitSha == sha &&
                    File.Exists(target) && Common.Sha256File(target) == prior.Sha256)
                {
                    nextFiles.Add(relative, prior);
                    continue;
                }
                string url = $"https://raw.githubusercontent.com/{Repository}/{commit}/{Common.EncodePath(relative)}";
                byte[] bytes = await Common.Download(url, 128_000_000);
                if (bytes.LongLength != size || GitBlobSha(bytes) != sha)
                    throw new InvalidDataException("Git blob checksum mismatch: " + relative);
                if (bytes.AsSpan().StartsWith("version https://git-lfs.github.com/spec/v1"u8))
                    throw new InvalidDataException("Git LFS pointer requires a separate asset loader: " + relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllBytes(target, bytes);
                nextFiles.Add(relative, new(sha, Common.Sha256(bytes), size));
                downloaded++;
            }
            foreach (string relative in old.Files.Keys)
            {
                if (wanted.ContainsKey(relative)) continue;
                string target = Common.SafePath(stage, relative);
                if (File.Exists(target)) { File.Delete(target); removed++; }
            }
            File.WriteAllText(Path.Combine(stage, Manifest), JsonSerializer.Serialize(new GameState(Repository, commit, nextFiles), JsonOptions));
            Common.RejectLinks(stage);
            if (Directory.Exists(previous)) Common.DeleteTree(previous);
            if (Directory.Exists(game)) Directory.Move(game, previous);
            try { Directory.Move(stage, game); }
            catch { if (!Directory.Exists(game) && Directory.Exists(previous)) Directory.Move(previous, game); throw; }
        }
        catch { if (Directory.Exists(stage)) Common.DeleteTree(stage); throw; }
        return $"Kuningriigid {commit[..12]} installed in game/. Downloaded {downloaded} changed files; removed {removed} obsolete tracked files. Previous version is in game.previous. Game code was not started. Native DX12 compatibility is still incomplete.";
    }

    private static void SelfTest()
    {
        if (GitBlobSha(Encoding.ASCII.GetBytes("test\n")) != "9daeafb9864cf43055ae93beb0afd6c7d144bfa4")
            throw new Exception("Git blob SHA-1 calculation failed.");
        foreach (string bad in new[] { "../escape", "a/../../escape", "C:/evil", "a\\evil", "CON.txt", ".native-three-game-manifest.json" })
        {
            try { Common.CheckRelative(bad); throw new Exception("Unsafe path accepted: " + bad); }
            catch (InvalidDataException) { }
        }
    }

    private static int Main(string[] args) => Common.Run("Game-Updater", args, Update, SelfTest);
}
