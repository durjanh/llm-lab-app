using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>List prices for one model, in US dollars per million tokens (python/common.py's PRICES).</summary>
public sealed class ModelPrice
{
    public decimal Input { get; set; }

    public decimal CachedInput { get; set; }

    public decimal Output { get; set; }
}

/// <summary>The "Pricing" section of appsettings.json: model deployment name -> its prices.</summary>
public sealed class PricingOptions
{
    public const string Section = "Pricing";

    public Dictionary<string, ModelPrice> Models { get; set; } = [];
}

/// <summary>What this run has spent, against its budget.</summary>
public interface ISpendTracker
{
    decimal SpentUsd { get; }

    decimal BudgetUsd { get; }

    bool OverBudget { get; }

    /// <summary>Adds one turn's cost and returns it. A model with no price costs nothing here (and is not capped).</summary>
    decimal Charge(string model, TokenUsage usage);
}

public sealed class SpendTracker(IOptions<PricingOptions> pricing, IOptions<MedAssistOptions> options) : ISpendTracker
{
    private readonly Lock _lock = new();
    private decimal _spent;

    public decimal SpentUsd
    {
        get
        {
            lock (_lock)
            {
                return _spent;
            }
        }
    }

    public decimal BudgetUsd => options.Value.BudgetUsd;

    public bool OverBudget => SpentUsd >= BudgetUsd;

    public decimal Charge(string model, TokenUsage usage)
    {
        if (!pricing.Value.Models.TryGetValue(model, out var price))
        {
            return 0m;
        }
        // The input count includes the cached tokens, which are billed at the cached rate.
        var cost = ((usage.Input - usage.CachedInput) * price.Input + usage.CachedInput * price.CachedInput
                    + usage.Output * price.Output) / 1_000_000m;
        lock (_lock)
        {
            _spent += cost;
        }
        return cost;
    }
}
