using MedAssist.Domain;

namespace MedAssist.Data;

/// <summary>A practice database file: the domain's <see cref="IPracticeStore"/> on SQLite.</summary>
public sealed class SqlitePracticeStore(string path) : IPracticeStore
{
    public string Location { get; } = path;

    public bool Exists => File.Exists(Location);

    public void Recreate(DateOnly today, DateTime now) => PracticeSchema.Create(Location, today, now);

    public IPracticeRepository Open() => new SqlitePracticeRepository(Location);

    /// <summary>As the Python backend's TranscriptArchive.keep_database names it: medassist-20261109-140225.db.</summary>
    public string? KeepCopy(string folder, DateTime now)
    {
        if (!Exists)
        {
            return null;
        }
        Directory.CreateDirectory(folder);
        var target = Path.Combine(folder, $"{Path.GetFileNameWithoutExtension(Location)}-{now:yyyyMMdd-HHmmss}{Path.GetExtension(Location)}");
        File.Copy(Location, target, overwrite: true);
        return target;
    }
}

public sealed class SqlitePracticeStoreFactory : IPracticeStoreFactory
{
    public IPracticeStore At(string path) => new SqlitePracticeStore(path);
}
