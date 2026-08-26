import { useState } from "react";

export interface SubscriptionCatalogPlan {
  id: string;
  slug: string;
  providerName: string;
  name: string;
  billingPeriod: "monthly" | "annual" | "weekly" | "other";
  priceMicros: number | null;
  currency: string;
  officialUrl: string;
  termsVersion: string | null;
  termsLastVerifiedAt: number | null;
  isActive: number;
}

export interface SubscriptionCatalogPrice {
  id: string;
  providerName: string;
  modelKey: string;
  displayName: string;
  inputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  sourceUrl: string;
  effectiveFrom: number;
  effectiveTo: number | null;
}

const post = (body: unknown) => fetch("/api/admin/subscriptions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export default function SubscriptionCatalogAdmin({ initialPlans, initialPrices }: { initialPlans: SubscriptionCatalogPlan[]; initialPrices: SubscriptionCatalogPrice[] }) {
  const [plans, setPlans] = useState(initialPlans);
  const [prices, setPrices] = useState(initialPrices);
  const [status, setStatus] = useState<string | null>(null);

  const addPlan = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawPrice = String(form.get("price") ?? "").trim();
    setStatus("Saving subscription plan…");
    const body = {
      action: "create_plan",
      slug: String(form.get("slug") ?? "").trim(),
      providerName: String(form.get("providerName") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      billingPeriod: String(form.get("billingPeriod") ?? "monthly"),
      priceMicros: rawPrice === "" ? null : Math.round(Number(rawPrice) * 1_000_000),
      currency: String(form.get("currency") ?? "USD").trim().toUpperCase(),
      officialUrl: String(form.get("officialUrl") ?? "").trim(),
      termsVersion: String(form.get("termsVersion") ?? "").trim(),
      termsLastVerifiedAt: new Date(`${String(form.get("verifiedDate"))}T00:00:00Z`).getTime()
    };
    const response = await post(body);
    const result = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!response.ok || !result.id) {
      setStatus(result.error?.message ?? "Could not save the subscription plan.");
      return;
    }
    setPlans((current) => [...current, {
      id: result.id!, slug: body.slug, providerName: body.providerName, name: body.name,
      billingPeriod: body.billingPeriod as SubscriptionCatalogPlan["billingPeriod"], priceMicros: body.priceMicros,
      currency: body.currency, officialUrl: body.officialUrl, termsVersion: body.termsVersion,
      termsLastVerifiedAt: body.termsLastVerifiedAt, isActive: 1
    }]);
    event.currentTarget.reset();
    setStatus("Subscription plan saved and audit logged.");
  };

  const deactivatePlan = async (planId: string) => {
    setStatus("Deactivating plan…");
    const response = await post({ action: "deactivate_plan", planId });
    if (!response.ok) {
      setStatus("Could not deactivate the plan.");
      return;
    }
    setPlans((current) => current.map((plan) => plan.id === planId ? { ...plan, isActive: 0 } : plan));
    setStatus("Plan deactivated; historical subscriptions remain intact.");
  };

  const addPrice = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dollarsToMicros = (name: string) => Math.round(Number(form.get(name)) * 1_000_000);
    setStatus("Saving model price…");
    const body = {
      action: "create_price",
      providerName: String(form.get("providerName") ?? "").trim(),
      modelKey: String(form.get("modelKey") ?? "").trim(),
      displayName: String(form.get("displayName") ?? "").trim(),
      inputMicrosPerMillion: dollarsToMicros("inputRate"),
      cacheReadMicrosPerMillion: dollarsToMicros("cacheReadRate"),
      cacheWriteMicrosPerMillion: dollarsToMicros("cacheWriteRate"),
      outputMicrosPerMillion: dollarsToMicros("outputRate"),
      reasoningMicrosPerMillion: 0,
      sourceUrl: String(form.get("sourceUrl") ?? "").trim(),
      effectiveFrom: new Date(`${String(form.get("effectiveDate"))}T00:00:00Z`).getTime()
    };
    const response = await post(body);
    const result = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!response.ok || !result.id) {
      setStatus(result.error?.message ?? "Could not save the model price.");
      return;
    }
    setPrices((current) => [...current, {
      id: result.id!, providerName: body.providerName, modelKey: body.modelKey,
      displayName: body.displayName, inputMicrosPerMillion: body.inputMicrosPerMillion,
      cacheReadMicrosPerMillion: body.cacheReadMicrosPerMillion,
      cacheWriteMicrosPerMillion: body.cacheWriteMicrosPerMillion,
      outputMicrosPerMillion: body.outputMicrosPerMillion, sourceUrl: body.sourceUrl,
      effectiveFrom: body.effectiveFrom, effectiveTo: null
    }]);
    event.currentTarget.reset();
    setStatus("Model price saved and audit logged.");
  };

  const closePrice = async (priceId: string) => {
    const current = new Date();
    const effectiveTo = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    setStatus("Closing model price…");
    const response = await post({ action: "close_price", priceId, effectiveTo });
    if (!response.ok) {
      setStatus("Could not close the model price.");
      return;
    }
    setPrices((current) => current.map((price) => price.id === priceId ? { ...price, effectiveTo } : price));
    setStatus("Price interval closed. Add the replacement price with its effective date.");
  };

  return <section aria-labelledby="subscription-catalog-heading" className="rounded-xl border border-[#e5e6e8] p-4">
    <h2 id="subscription-catalog-heading" className="m-0 text-lg font-extrabold tracking-[-.03em]">Subscription and model-price catalog</h2>
    <p className="mt-1 text-sm text-[#59636e]">Public plan terms and time-versioned API prices power comparable value estimates. Verify every value against an official source.</p>
    <p role="status" aria-live="polite" className="text-sm text-[#59636e]">{status}</p>
    <div className="grid gap-5 lg:grid-cols-2">
      <form className="grid gap-3 rounded-xl bg-[#fafafa] p-4 sm:grid-cols-2" onSubmit={(event) => void addPlan(event)}>
        <h3 className="m-0 sm:col-span-2">Add market plan</h3>
        <label>Slug<input name="slug" required placeholder="provider-plan-tier" /></label>
        <label>Provider<input name="providerName" required placeholder="Anthropic" /></label>
        <label>Plan name<input name="name" required placeholder="Claude Max 5x" /></label>
        <label>Billing<select name="billingPeriod" defaultValue="monthly"><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="weekly">Weekly</option><option value="other">Other</option></select></label>
        <label>Price (currency units)<input name="price" type="number" min="0" step="0.01" placeholder="Leave blank if unverified" /></label>
        <label>Currency<input name="currency" defaultValue="USD" pattern="[A-Za-z]{3}" required /></label>
        <label className="sm:col-span-2">Official plan URL<input name="officialUrl" type="url" required /></label>
        <label>Terms version<input name="termsVersion" required placeholder="2026-08" /></label>
        <label>Verified date<input name="verifiedDate" type="date" required /></label>
        <button className="button-dark sm:col-span-2" type="submit">Add plan</button>
      </form>
      <form className="grid gap-3 rounded-xl bg-[#fafafa] p-4 sm:grid-cols-2" onSubmit={(event) => void addPrice(event)}>
        <h3 className="m-0 sm:col-span-2">Add time-versioned model price</h3>
        <label>Provider<input name="providerName" required placeholder="Anthropic" /></label>
        <label>Exact model key<input name="modelKey" required placeholder="claude-sonnet-5" /></label>
        <label>Display name<input name="displayName" required /></label>
        <label>Effective date<input name="effectiveDate" type="date" required /></label>
        <label>Input $ / 1M<input name="inputRate" type="number" min="0" step="0.000001" required /></label>
        <label>Cache read $ / 1M<input name="cacheReadRate" type="number" min="0" step="0.000001" required /></label>
        <label>Cache write $ / 1M<input name="cacheWriteRate" type="number" min="0" step="0.000001" required /></label>
        <label>Output $ / 1M<input name="outputRate" type="number" min="0" step="0.000001" required /></label>
        <label className="sm:col-span-2">Official pricing URL<input name="sourceUrl" type="url" required /></label>
        <button className="button-dark sm:col-span-2" type="submit">Add price interval</button>
      </form>
    </div>
    <div className="mt-5 overflow-x-auto rounded-xl border border-[#e5e6e8]"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead className="bg-[#fafafa]"><tr><th className="p-3">Plan</th><th className="p-3">Terms</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id} className="border-t border-[#ececeb]"><td className="p-3"><b>{plan.name}</b><div className="text-xs text-[#59636e]">{plan.providerName} · {plan.slug}</div></td><td className="p-3">{plan.priceMicros === null ? "Unpriced" : `${plan.currency} ${(plan.priceMicros / 1_000_000).toFixed(2)}`} / {plan.billingPeriod}<div><a href={plan.officialUrl} rel="noreferrer" target="_blank">official source</a></div></td><td className="p-3">{plan.isActive ? "Active" : "Inactive"}</td><td className="p-3">{plan.isActive ? <button className="button-light !min-h-9 !px-3 !py-1" type="button" onClick={() => void deactivatePlan(plan.id)}>Deactivate</button> : "—"}</td></tr>)}</tbody></table></div>
    <div className="mt-5 overflow-x-auto rounded-xl border border-[#e5e6e8]"><table className="w-full min-w-[900px] border-collapse text-left text-sm"><thead className="bg-[#fafafa]"><tr><th className="p-3">Model</th><th className="p-3">Input/cache read/cache write/output $ per 1M</th><th className="p-3">Effective</th><th className="p-3">Action</th></tr></thead><tbody>{prices.map((price) => <tr key={price.id} className="border-t border-[#ececeb]"><td className="p-3"><b>{price.displayName}</b><div className="text-xs text-[#59636e]">{price.providerName} · {price.modelKey}</div></td><td className="p-3">{[price.inputMicrosPerMillion, price.cacheReadMicrosPerMillion, price.cacheWriteMicrosPerMillion, price.outputMicrosPerMillion].map((value) => `$${(value / 1_000_000).toFixed(3)}`).join(" / ")}</td><td className="p-3">{new Date(price.effectiveFrom).toISOString().slice(0, 10)} → {price.effectiveTo ? new Date(price.effectiveTo).toISOString().slice(0, 10) : "current"}<div><a href={price.sourceUrl} rel="noreferrer" target="_blank">source</a></div></td><td className="p-3">{price.effectiveTo === null ? <button className="button-light !min-h-9 !px-3 !py-1" type="button" onClick={() => void closePrice(price.id)}>Close today</button> : "—"}</td></tr>)}</tbody></table></div>
  </section>;
}
