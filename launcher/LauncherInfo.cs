using System.Text.Json;
using System.Text.RegularExpressions;
using NativeThreeBridge.Updates;

// What Launcher.exe shows: game name, versions, picture and the latest
// changes. Output lines (tab separated): INFO <key> <value>, NEWS <date>
// <source> <text>.
internal static class LauncherInfo
{
    private static readonly Regex VersionPattern = new(@"\b[vV]\.?\s?(\d+(?:\.\d+){0,3})\b", RegexOptions.CultureInvariant);

    // <title>Kuningriigid · V353</title> -> ("Kuningriigid", "V353")
    internal static (string name, string version) TitleInfo(string html)
    {
        Match title = Regex.Match(html, @"<title[^>]*>([^<]*)</title>", RegexOptions.IgnoreCase);
        string text = System.Net.WebUtility.HtmlDecode(title.Success ? title.Groups[1].Value : "").Trim();
        Match version = VersionPattern.Match(text);
        string name = version.Success ? text.Remove(version.Index, version.Length) : text;
        name = Regex.Replace(name, @"\s+", " ").Trim(' ', '·', '-', '–', '—', '|', ':', ',');
        return (name, version.Success ? "V" + version.Groups[1].Value : "");
    }

    // Optional native-launcher.json in the game: { "name", "version", "image" }.
    private static (string? name, string? version, string? image) Meta(string json)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(json);
            string? Get(string key) => doc.RootElement.TryGetProperty(key, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return (Get("name"), Get("version"), Get("image"));
        }
        catch (JsonException) { return (null, null, null); }
    }

    // The main menu's background picture: CSS rules (stylesheets in index.html
    // order) whose selector ends in a menu/start/title element and set a
    // background url(); of those pictures the largest file (icons are small).
    internal static string? MenuBackground(string game, string html)
    {
        List<(string css, string dir)> sheets = new();
        foreach (Match link in Regex.Matches(html, @"<link\b[^>]*>", RegexOptions.IgnoreCase))
        {
            if (!Regex.IsMatch(link.Value, @"rel\s*=\s*[""']?stylesheet", RegexOptions.IgnoreCase)) continue;
            Match href = Regex.Match(link.Value, @"href\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase);
            if (!href.Success) continue;
            string relative = href.Groups[1].Value.Split('?', '#')[0].TrimStart('.', '/');
            if (relative.Contains("://")) continue;
            try
            {
                string path = Common.SafePath(game, relative);
                if (File.Exists(path) && new FileInfo(path).Length < 4_000_000)
                    sheets.Add((File.ReadAllText(path), Path.GetDirectoryName(path)!));
            }
            catch (InvalidDataException) { }
        }
        foreach (Match style in Regex.Matches(html, @"<style[^>]*>([\s\S]*?)</style>", RegexOptions.IgnoreCase))
            sheets.Add((style.Groups[1].Value, game));
        string? found = null;
        long foundSize = -1;
        Regex menu = new(@"[#.][\w-]*(menu|start|title|splash|intro|lobby)[\w-]*", RegexOptions.IgnoreCase);
        foreach ((string css, string dir) in sheets)
        {
            string clean = Regex.Replace(css, @"/\*[\s\S]*?\*/", "");
            foreach (Match rule in Regex.Matches(clean, @"([^{}]+)\{([^{}]*)\}"))
            {
                string selector = rule.Groups[1].Value;
                if (selector.Contains("::") || selector.Contains(":hover")) continue;
                // the element the rule styles: last compound of each selector in the list
                if (!selector.Split(',').Any(part => menu.IsMatch(Regex.Split(part.Trim(), @"[\s>+~]+").Last()))) continue;
                foreach (Match url in Regex.Matches(rule.Groups[2].Value, @"background(?:-image)?\s*:[^;]*?url\(\s*[""']?([^""')]+)[""']?\s*\)", RegexOptions.IgnoreCase))
                {
                    string target = url.Groups[1].Value;
                    if (target.StartsWith("data:") || target.EndsWith(".svg", StringComparison.OrdinalIgnoreCase)) continue;
                    string full = Path.GetFullPath(Path.Combine(dir, target.Split('?', '#')[0].Replace('/', Path.DirectorySeparatorChar)));
                    if (!full.StartsWith(Path.GetFullPath(game) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) continue;
                    long size = new FileInfo(full).Length;
                    if (size >= foundSize) { found = full; foundSize = size; }
                }
            }
        }
        return found;
    }

    // The game's own change notes (MUUDATUSED_V358.md, CHANGELOG_V2.md ...):
    // newest versions first, "<heading>: <first sentence>".
    private static readonly Regex NotesFile = new(@"^(MUUDATUSED|CHANGES|CHANGELOG|UPDATE|UUENDUS)[_-]?V?(\d+(?:\.\d+)*)\.md$", RegexOptions.IgnoreCase);
    internal static List<(string version, string text)> LocalNotes(string game, int count)
    {
        var notes = new List<(Version order, string label, string path)>();
        foreach (string file in Directory.EnumerateFiles(game, "*.md", SearchOption.TopDirectoryOnly))
        {
            Match m = NotesFile.Match(Path.GetFileName(file));
            if (!m.Success) continue;
            string number = m.Groups[2].Value;
            string padded = number.Contains('.') ? number : number + ".0";
            if (Version.TryParse(padded, out Version? order)) notes.Add((order, "V" + number, file));
        }
        var result = new List<(string, string)>();
        foreach (var note in notes.OrderByDescending(n => n.order).Take(count))
        {
            string[] lines = File.ReadAllLines(note.path).Select(l => l.Trim()).ToArray();
            string heading = lines.FirstOrDefault(l => l.StartsWith('#'))?.TrimStart('#').Trim() ?? "";
            // "V358 – Uus kindlus" -> "Uus kindlus"
            heading = Regex.Replace(heading, @"^[vV]?\d+(?:\.\d+)*\s*[–—:-]\s*", "");
            string paragraph = lines.FirstOrDefault(l => l.Length > 0 && !l.StartsWith('#') && !l.StartsWith("---")) ?? "";
            paragraph = Regex.Replace(paragraph, @"[*_`]", "");
            Match sentence = Regex.Match(paragraph, @"^.*?[.!?](\s|$)");
            string first = sentence.Success ? sentence.Value.Trim() : paragraph;
            if (first.Length > 170) first = first[..167].TrimEnd() + "…";
            if (heading.Length > 0) heading = char.ToUpper(heading[0]) + heading[1..];
            string text = heading.Length == 0 ? first : first.Length == 0 ? heading : heading + ". " + first;
            if (text.Length > 0) result.Add((note.label, text));
        }
        return result;
    }

    internal static void Local()
    {
        string game = Path.Combine(Common.Root, Config.GameFolder);
        string index = Path.Combine(game, "index.html");
        bool installed = File.Exists(index);
        string name = "", version = "", image = "", commit = "";
        if (installed)
        {
            string html = File.ReadAllText(index);
            (name, version) = TitleInfo(html);
            string metaPath = Path.Combine(game, "native-launcher.json");
            (string? metaName, string? metaVersion, string? metaImage) = File.Exists(metaPath) ? Meta(File.ReadAllText(metaPath)) : (null, null, null);
            if (!string.IsNullOrWhiteSpace(metaName)) name = metaName!;
            if (!string.IsNullOrWhiteSpace(metaVersion)) version = metaVersion!;
            if (metaImage is not null)
            {
                try { string p = Common.SafePath(game, metaImage); if (File.Exists(p)) image = p; } catch (InvalidDataException) { }
            }
            if (image == "") image = MenuBackground(game, html) ?? "";
            try { commit = GameUpdater.ReadOld(game).Commit; } catch (Exception) { }
        }
        if (name == "") name = Config.GameRepository.Split('/')[1];
        if (installed)
            foreach ((string version, string text) in LocalNotes(game, 12))
                Out.Line($"NEWS_LOCAL\t{version}\t{Config.GameNewsLabel}\t{text}");
        Out.Line("INFO\tNAME\t" + name);
        Out.Line("INFO\tIMAGE\t" + image);
        Out.Line("INFO\tENGINE\t" + UpdateEngine.Installed());
        Out.Line("INFO\tGAME_INSTALLED\t" + (installed ? "1" : "0"));
        Out.Line("INFO\tGAME_VERSION\t" + (version != "" ? version : commit.Length >= 7 ? commit[..7] : ""));
        Out.Line("INFO\tGAME_COMMIT\t" + commit);
    }

    // Latest stable engine and game commit on GitHub, and the news list.
    internal static async Task Status()
    {
        List<(DateTimeOffset date, string source, string text)> news = new();
        string engineLatest = "";
        using (JsonDocument releases = await Common.GetJson($"https://api.github.com/repos/{Config.EngineRepository}/releases?per_page=15"))
        {
            foreach (JsonElement release in releases.RootElement.EnumerateArray())
            {
                if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean()) continue;
                string tag = release.GetProperty("tag_name").GetString() ?? "";
                if (engineLatest == "") engineLatest = tag;
                string title = release.TryGetProperty("name", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : tag;
                if (DateTimeOffset.TryParse(release.GetProperty("published_at").GetString(), out DateTimeOffset date))
                {
                    // "NativeThreeBridge v0.36.0 – Launcher ..." -> "v0.36.0 – Launcher ..."
                    if (title.StartsWith("NativeThreeBridge ", StringComparison.Ordinal)) title = title["NativeThreeBridge ".Length..];
                    news.Add((date, "Engine", title.Contains(tag) ? title : tag + " – " + title));
                }
            }
        }
        string commit = "";
        using (JsonDocument commits = await Common.GetJson($"https://api.github.com/repos/{Config.GameRepository}/commits?sha={Uri.EscapeDataString(Config.GameBranch)}&per_page=25"))
        {
            foreach (JsonElement entry in commits.RootElement.EnumerateArray())
            {
                string sha = entry.GetProperty("sha").GetString() ?? "";
                if (commit == "") commit = sha;
                JsonElement c = entry.GetProperty("commit");
                string message = (c.GetProperty("message").GetString() ?? "").Split('\n')[0].Trim();
                if (message.StartsWith("Merge ", StringComparison.Ordinal) || message == "") continue;
                if (DateTimeOffset.TryParse(c.GetProperty("committer").GetProperty("date").GetString(), out DateTimeOffset date))
                    news.Add((date, "Mäng", message));
            }
        }
        if (!Common.HashValid(commit, 40)) throw new InvalidDataException("GitHub did not return the game's latest commit.");
        string version = commit[..7];
        try
        {
            string raw = $"https://raw.githubusercontent.com/{Config.GameRepository}/{commit}/";
            string html = System.Text.Encoding.UTF8.GetString(await Common.Download(raw + "index.html", 8_000_000));
            (_, string titleVersion) = TitleInfo(html);
            if (titleVersion != "") version = titleVersion;
            try
            {
                (_, string? metaVersion, _) = Meta(System.Text.Encoding.UTF8.GetString(await Common.Download(raw + "native-launcher.json", 65536)));
                if (!string.IsNullOrWhiteSpace(metaVersion)) version = metaVersion!;
            }
            catch (HttpRequestException) { } // the game has no native-launcher.json
        }
        catch (HttpRequestException) { }
        Out.Line("INFO\tENGINE_LATEST\t" + engineLatest);
        Out.Line("INFO\tGAME_LATEST_COMMIT\t" + commit);
        Out.Line("INFO\tGAME_LATEST_VERSION\t" + version);
        foreach ((DateTimeOffset date, string source, string text) in news.OrderByDescending(n => n.date).Take(40))
            Out.Line($"NEWS\t{date.ToLocalTime():dd.MM.yyyy}\t{source}\t{text}");
    }

    internal static void SelfTest()
    {
        if (TitleInfo("<title>Kuningriigid · V353</title>") != ("Kuningriigid", "V353")) throw new Exception("Title parsing failed.");
        string notesDir = Path.Combine(Path.GetTempPath(), "ntb-notes-test-" + Environment.ProcessId);
        Directory.CreateDirectory(notesDir);
        try
        {
            File.WriteAllText(Path.Combine(notesDir, "MUUDATUSED_V9.md"), "# V9 – vana\n\nVana asi.");
            File.WriteAllText(Path.Combine(notesDir, "MUUDATUSED_V227.3.md"), "# V227.3 – kiviaja mudelid\n\nUued mudelid on valmis. Teine lause.");
            File.WriteAllText(Path.Combine(notesDir, "MUUDATUSED_V30.md"), "# V30 – keskmine\n\nKeskmine asi.");
            var notes = LocalNotes(notesDir, 2);
            if (notes.Count != 2 || notes[0].version != "V227.3" || notes[0].text != "Kiviaja mudelid. Uued mudelid on valmis." || notes[1].version != "V30")
                throw new Exception("Change notes: " + string.Join(" | ", notes));
        }
        finally { Directory.Delete(notesDir, true); }
        if (TitleInfo("<title>My Game</title>") != ("My Game", "")) throw new Exception("Title without version failed.");
        if (TitleInfo("<title>Space v1.2.3 - demo</title>") != ("Space - demo", "V1.2.3")) throw new Exception("Dotted version failed.");
        string dir = Path.Combine(Path.GetTempPath(), "ntb-launcher-test-" + Environment.ProcessId);
        Directory.CreateDirectory(Path.Combine(dir, "art"));
        try
        {
            File.WriteAllText(Path.Combine(dir, "art", "menu.webp"), "x");
            File.WriteAllText(Path.Combine(dir, "art", "icon.webp"), "");
            File.WriteAllText(Path.Combine(dir, "a.css"), "#hud{background:url('art/hud.webp')} #startmenu{color:red;background:linear-gradient(#000,#111),url('art/menu.webp') center/cover} #startmenu .card{background:url('art/icon.webp')} #menubtn::before{background:url('art/icon.webp')}");
            string? found = MenuBackground(dir, "<link rel=\"stylesheet\" href=\"a.css?v=1\">");
            if (found is null || !found.EndsWith("menu.webp")) throw new Exception("Menu background not found: " + found);
        }
        finally { Directory.Delete(dir, true); }
    }
}
