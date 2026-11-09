namespace MedAssist.Domain;

/// <summary>
/// One practice database (the live one, or the one the checked tests rebuild): whether it exists, rebuilding it, and
/// opening a repository on it. The data layer implements it.
/// </summary>
public interface IPracticeStore
{
    /// <summary>Where it is, for messages.</summary>
    string Location { get; }

    bool Exists { get; }

    /// <summary>A fresh database: four weeks of diaries from <paramref name="today"/>. Everything booked is lost.</summary>
    void Recreate(DateOnly today, DateTime now);

    IPracticeRepository Open();

    /// <summary>A copy of the database in <paramref name="folder"/>, named with the time, before it is rebuilt.
    /// Returns where it went, or null when there is no database to copy.</summary>
    string? KeepCopy(string folder, DateTime now);
}

/// <summary>Makes a store for a database file, so the services can use the live one or a test one.</summary>
public interface IPracticeStoreFactory
{
    IPracticeStore At(string path);
}
