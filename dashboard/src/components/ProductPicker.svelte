<script>
  import Icon from './Icon.svelte';
  import { api } from '../lib/api.js';
  import { ui } from '../lib/state.svelte.js';
  import { demoSearch } from '../lib/groceries.js';

  // query is the add field. matching is set when an existing grocery line is being resolved.
  // onplain is omitted when a typed line isn't useful (the Delivery tab).
  let { query, matching = '', saving = false, onpick, onplain = null } = $props();

  let products = $state([]);
  let errors = $state([]);
  let searching = $state(false);
  let failed = $state('');
  let unavailable = $state(false);
  let relayOffline = $state(false);
  let attempt = $state(0);
  let broken = $state({});

  function extra(product) {
    const hay = product.name.toLowerCase();
    const brand = product.brand && product.brand.toLowerCase() !== product.storeName.toLowerCase() && !hay.includes(product.brand.toLowerCase()) ? product.brand : '';
    const size = product.size && !hay.includes(product.size.toLowerCase()) ? product.size : '';
    return [brand, size].filter(Boolean).join(' · ');
  }

  function retry() { attempt += 1; }

  $effect(() => {
    const q = query.trim();
    const n = attempt;
    let timer;
    const ctrl = new AbortController();
    if (q.length < 2) {
      products = [];
      errors = [];
      failed = '';
      unavailable = false;
      relayOffline = false;
      searching = false;
      return;
    }
    searching = true;
    failed = '';
    unavailable = false;
    relayOffline = false;
    timer = setTimeout(() => run(q, ctrl.signal), n ? 0 : 400);
    return () => { clearTimeout(timer); ctrl.abort(); };
  });

  async function run(q, signal) {
    try {
      const data = ui.demo ? demoSearch(q) : await api('/api/groceries/search?q=' + encodeURIComponent(q), { signal });
      if (signal.aborted) return;
      products = data.products || [];
      errors = data.errors || [];
      unavailable = !!data.unavailable || errors.some((err) => err.unavailable);
      relayOffline = !!(data.relay && data.relay.online === false);
      failed = '';
      searching = false;
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') return;
      products = [];
      errors = [];
      unavailable = true;
      relayOffline = false;
      failed = 'Coles didn’t answer, retry';
      searching = false;
    }
  }
</script>

<div class="picker">
  <div class="sheet">
    <p class="hint">
      {#if matching}Choose a product for “{matching}”.
      {:else if query.trim().length < 2}Type a product, like 2L milk.
      {:else if searching}Searching Coles…
      {:else if unavailable || failed}Coles didn’t answer, retry
      {:else if !products.length}No Coles products matched.
      {:else}Tap a Coles product to add it.{/if}
    </p>
    {#if (unavailable || failed) && relayOffline && !searching}
      <p class="hint">Coles search needs the laptop on</p>
    {/if}
    {#if (unavailable || failed) && !searching}
      <button type="button" class="as-typed" onclick={retry}>Retry</button>
    {/if}
    <div class="results">
      {#each products as product (product.store + product.id)}
        <button type="button" class="product" disabled={saving} onclick={() => onpick(product)}>
          {#if product.image && !broken[product.id]}
            <img src={product.image} alt="" width="64" height="64" decoding="async" referrerpolicy="no-referrer" onerror={() => (broken[product.id] = true)} />
          {:else}
            <span class="ph"><Icon name="cart" size={28} /></span>
          {/if}
          <span class="copy">
            <span class="name">{product.name}</span>
            <span class="sub">
              {#if extra(product)}<span>{extra(product)}</span>{/if}
            </span>
            <span class="price num">
              {#if !product.available}Unavailable
              {:else}{product.priceLabel || 'No price'}{/if}
              {#if product.unitPrice}<span class="unit">{product.unitPrice}</span>{/if}
            </span>
          </span>
        </button>
      {/each}
    </div>
    {#if onplain && !matching}
      <button type="button" class="as-typed" disabled={!query.trim() || saving} onclick={onplain}>
        <span>Add “{query.trim() || '…'}” as typed</span>
      </button>
    {/if}
  </div>
</div>

<style>
  .picker { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .sheet { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px 18px 12px; }
  .hint { margin: 0; font-size: 17px; color: var(--secondary); }
  .results { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; align-content: start; }
  .product { display: flex; align-items: center; gap: 12px; min-height: 84px; padding: 8px 4px; border-bottom: 1px solid var(--sep); text-align: left; }
  .product:disabled { opacity: .5; }
  .product:active { opacity: .7; }
  img, .ph { flex: none; width: 64px; height: 64px; border-radius: 12px; background: var(--ground); object-fit: cover; }
  .ph { display: grid; place-items: center; color: var(--secondary); }
  .copy { flex: 1; min-width: 0; }
  .name { display: block; font-size: 20px; font-weight: 600; overflow: hidden; max-height: 2.5em; }
  .sub { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 15px; color: var(--secondary); }
  .price { display: block; margin-top: 2px; font-size: 18px; font-weight: 700; }
  .unit { margin-left: 8px; font-size: 15px; font-weight: 500; color: var(--secondary); }
  .as-typed { flex: none; display: flex; align-items: center; justify-content: center; height: 52px; padding: 0 16px; border-radius: 16px; background: var(--ground); font-size: 18px; font-weight: 600; }
  .as-typed span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .as-typed:disabled { opacity: .4; }
  .as-typed:active { opacity: .7; }
</style>
