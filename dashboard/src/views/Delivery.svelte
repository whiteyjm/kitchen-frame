<script>
  import Icon from '../components/Icon.svelte';
  import ProductPicker from '../components/ProductPicker.svelte';
  import wordmark from '../assets/coles-wordmark.svg';
  import { api } from '../lib/api.js';
  import { demoSearch } from '../lib/groceries.js';
  import { ui, lists, loadList } from '../lib/state.svelte.js';
  import { money, colesProductUrl, groceryName, groceryQuantity, colesSearchQueries } from '../../shared/product.js';

  // Coles only. Send snapshots the basket for an assistant to fill the real cart; nothing is paid here.
  const STATUS = {
    pending: 'Pending — waiting to be added to the Coles cart',
    'filled-in-cart': 'In the Coles cart — finish checkout on Coles',
    done: 'Done',
  };

  let items = $state([]);
  let order = $state(null);
  let loading = $state(true);
  let ready = $state(false);
  let error = $state('');
  let adding = $state(false);
  let draft = $state('');
  let sending = $state(false);
  let bulkBusy = $state(false);
  let bulkNote = $state('');
  let progress = $state('');
  let broken = $state({});
  let field = $state(null);

  let sum = $derived(Math.round(items.reduce((n, item) => n + (item.price == null ? 0 : item.price * item.quantity), 0) * 100) / 100);
  let missingPrice = $derived(items.some((item) => item.price == null));
  let stale = $derived.by(() => !!(order && order.items && items.length && sig(items) !== sig(order.items)));
  let groceryKnownEmpty = $derived(Array.isArray(lists.groceries.items) && lists.groceries.items.length === 0);

  function sig(list) {
    return (list || []).map((item) => item.id + '×' + item.quantity).join('|');
  }
  function extra(item) {
    const hay = item.name.toLowerCase();
    const brand = item.brand && !hay.includes(item.brand.toLowerCase()) ? item.brand : '';
    const size = item.size && !hay.includes(item.size.toLowerCase()) ? item.size : '';
    return [brand, size].filter(Boolean).join(' · ');
  }
  function line(item) {
    if (item.price == null) return '';
    return money(Math.round(item.price * item.quantity * 100) / 100);
  }
  function stamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function snapshot(list) {
    return list.map((item) => ({
      id: String(item.id),
      name: item.name,
      brand: item.brand || '',
      size: item.size || '',
      price: item.price ?? null,
      image: item.image || '',
      quantity: item.quantity,
      url: item.url || colesProductUrl(item),
    }));
  }

  let saveTimer;
  let saveChain = Promise.resolve();

  function rememberDemo(nextItems, nextOrder) {
    try { localStorage.setItem('frame-delivery', JSON.stringify({ items: nextItems, order: nextOrder })); } catch {}
  }
  async function writeBasket(nextItems, demo) {
    if (demo) {
      rememberDemo(nextItems, order);
      return;
    }
    const saved = await api('/api/delivery/basket', { method: 'PUT', body: JSON.stringify({ items: nextItems }) });
    // A tap during the request keeps the newer quantities; the next save writes those.
    if (sig(items) === sig(nextItems)) items = saved.items || [];
  }
  function scheduleSave() {
    if (!ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const nextItems = snapshot(items);
      const demo = ui.demo;
      saveChain = saveChain.then(() => writeBasket(nextItems, demo)).catch((err) => {
        error = 'Couldn’t save the basket: ' + err.message;
      });
    }, 300);
  }
  function flushSave() {
    if (!ready) return saveChain;
    clearTimeout(saveTimer);
    const nextItems = snapshot(items);
    const demo = ui.demo;
    saveChain = saveChain.then(() => writeBasket(nextItems, demo));
    return saveChain;
  }

  function addProduct(product, save = true, count = 1) {
    if (!product || product.store !== 'coles') return false;
    const id = String(product.id ?? '').trim();
    const name = String(product.name || '').trim();
    if (!id || !name) return false;
    const add = Math.min(99, Math.max(1, Math.round(Number(count) || 1)));
    const row = {
      id,
      name,
      brand: String(product.brand || '').trim(),
      size: String(product.size || '').trim(),
      price: product.price ?? null,
      image: product.image || '',
      quantity: add,
      url: colesProductUrl(product) || product.url || '',
    };
    if (items.some((item) => item.id === id)) {
      items = items.map((item) => item.id === id ? { ...item, quantity: Math.min(99, item.quantity + add) } : item);
    } else {
      items = [...items, row];
    }
    if (save) scheduleSave();
    return true;
  }
  function setQty(id, quantity) {
    if (quantity < 1 || quantity > 99) return;
    items = items.map((item) => item.id === id ? { ...item, quantity } : item);
    scheduleSave();
  }
  function remove(id) {
    items = items.filter((item) => item.id !== id);
    scheduleSave();
  }

  function openAdd() {
    adding = true;
    requestAnimationFrame(() => field && field.focus());
  }
  function closeAdd() { adding = false; draft = ''; }
  function choose(product) {
    if (sending || bulkBusy) return;
    if (!addProduct(product)) return;
    draft = '';
    field && field.focus();
  }

  async function send() {
    if (!items.length || sending || bulkBusy) return;
    sending = true;
    error = '';
    try {
      await flushSave();
      if (ui.demo) {
        order = {
          status: 'pending',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          items: snapshot(items),
          subtotal: sum,
        };
        rememberDemo(snapshot(items), order);
      } else {
        order = await api('/api/delivery/submit', { method: 'POST' });
      }
      bulkNote = '';
    } catch (err) {
      error = 'Couldn’t send the order: ' + err.message;
    }
    sending = false;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // One Coles lookup. A block is tried once more; a real miss moves on to a shorter query.
  async function lookup(q) {
    let blocked = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wait(400);
      try {
        const data = ui.demo ? demoSearch(q) : await api('/api/groceries/search?q=' + encodeURIComponent(q));
        const hit = (data.products || []).find((p) => p.store === 'coles' && p.available !== false);
        if (hit) return { hit };
        if (data.unavailable) { blocked = true; continue; }
        return { hit: null };
      } catch {
        blocked = true;
      }
    }
    return { hit: null, unavailable: blocked };
  }

  // One grocery line at a time, so a burst of searches doesn't trip Coles. The ×N suffix and
  // any "For:" note are stripped, then a shorter query is tried before giving up.
  async function addGroceryList() {
    if (bulkBusy || sending) return;
    bulkBusy = true;
    bulkNote = '';
    error = '';
    progress = 'Loading the grocery list…';
    try {
      await loadList('groceries');
      const source = (lists.groceries.items || []).filter((item) => groceryName(item).trim().length >= 2).slice(0, 30);
      if (!source.length) {
        bulkNote = lists.groceries.error || 'Grocery list is empty.';
        return;
      }
      let added = 0;
      const missed = [];
      const unanswered = [];
      for (let n = 0; n < source.length; n++) {
        const item = source[n];
        const name = groceryName(item);
        progress = 'Matching ' + (n + 1) + ' of ' + source.length + '…';
        const queries = colesSearchQueries(item.content);
        let hit = null;
        let blocked = false;
        for (const q of queries) {
          const found = await lookup(q);
          if (found.hit) { hit = found.hit; break; }
          if (found.unavailable) blocked = true;
          else blocked = false;
        }
        if (hit && addProduct(hit, false, groceryQuantity(item))) added++;
        else if (blocked) unanswered.push(name);
        else if (queries.length) missed.push(name);
        if (n + 1 < source.length) await wait(ui.demo ? 0 : 350);
      }
      await flushSave();
      const parts = [];
      if (added) parts.push('Added ' + added + ' from the grocery list.');
      if (missed.length) parts.push('Couldn’t match: ' + missed.join(', ') + '.');
      if (unanswered.length) parts.push('Coles didn’t answer for: ' + unanswered.join(', ') + '.');
      bulkNote = parts.join(' ') || 'Grocery list is empty.';
    } catch (err) {
      bulkNote = err.message;
    } finally {
      bulkBusy = false;
      progress = '';
    }
  }

  $effect(() => {
    const demo = ui.demo;
    let gone = false;
    loading = true;
    ready = false;
    items = [];
    order = null;
    error = '';
    (async () => {
      try {
        if (demo) {
          let saved = null;
          try { saved = JSON.parse(localStorage.getItem('frame-delivery') || 'null'); } catch {}
          if (gone) return;
          items = Array.isArray(saved?.items) ? saved.items : [];
          order = saved?.order?.status ? saved.order : null;
        } else {
          const [basket, pending] = await Promise.all([api('/api/delivery/basket'), api('/api/delivery/pending')]);
          if (gone) return;
          items = basket.items || [];
          order = pending && pending.status ? pending : null;
        }
      } catch (err) {
        if (!gone) error = err.message;
      } finally {
        if (!gone) { loading = false; ready = true; }
      }
    })();
    return () => { gone = true; };
  });

  // While an assistant is filling the cart, check once a minute. The view is destroyed when the tab closes.
  $effect(() => {
    const status = order && order.status;
    if (ui.demo || (status !== 'pending' && status !== 'filled-in-cart')) return;
    const timer = setInterval(() => {
      api('/api/delivery/pending').then((pending) => {
        if (pending && pending.status) order = pending;
      }).catch(() => {});
    }, 60 * 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="wrap">
  <!-- Faint store mark, only on this tab. The sheets sit above it so prices and names stay readable. -->
  <img class="mark" src={wordmark} alt="" width="520" height="162" draggable="false" />
  <header class="bar">
    {#if adding}
      <form class="add" onsubmit={(e) => e.preventDefault()}>
        <span class="plus"><Icon name="plus" size={18} /></span>
        <input bind:this={field} bind:value={draft} placeholder="Search Coles" enterkeyhint="search" autocomplete="off" aria-label="Search Coles" />
        <button type="button" class="btn" onclick={closeAdd}>Done</button>
      </form>
    {:else}
      <h1>Delivery<span class="count">{items.length} {items.length === 1 ? 'product' : 'products'}</span></h1>
      <button type="button" class="btn tint" disabled={loading || sending} onclick={openAdd}><Icon name="plus" size={20} />Add</button>
    {/if}
  </header>
  {#if error}<p class="note">{error}</p>{/if}

  {#if adding && draft.trim().length >= 2}
    <ProductPicker query={draft} saving={sending || bulkBusy} onpick={choose} />
  {:else}
    <div class="body">
      <div class="sheet list">
        {#if loading}
          <p class="hint">Loading the basket…</p>
        {:else if !items.length}
          <div class="empty">
            <span class="empty-icon"><Icon name="cart" size={34} /></span>
            <h2>Basket is empty</h2>
            <p>Search Coles and tap a product. Prices are Coles Pialba online prices.</p>
          </div>
        {:else}
          {#each items as item (item.id)}
            <div class="row">
              {#if item.image && !broken[item.id]}
                <img src={item.image} alt="" width="72" height="72" decoding="async" referrerpolicy="no-referrer" onerror={() => (broken[item.id] = true)} />
              {:else}
                <span class="ph"><Icon name="cart" size={28} /></span>
              {/if}
              <span class="copy">
                <span class="name">{item.name}</span>
                <span class="meta">
                  {#if extra(item)}<span>{extra(item)}</span>{/if}
                  {#if item.price != null}<span>{money(item.price)} each</span>{/if}
                </span>
              </span>
              <span class="qty">
                <button type="button" class="step" aria-label={'Fewer ' + item.name} disabled={item.quantity <= 1} onclick={() => setQty(item.id, item.quantity - 1)}>−</button>
                <span class="n num">{item.quantity}</span>
                <button type="button" class="step" aria-label={'More ' + item.name} disabled={item.quantity >= 99} onclick={() => setQty(item.id, item.quantity + 1)}>+</button>
              </span>
              <span class="line num">{line(item) || '—'}</span>
              <button type="button" class="remove" aria-label={'Remove ' + item.name} onclick={() => remove(item.id)}><Icon name="trash" size={20} /></button>
            </div>
          {/each}
        {/if}
      </div>

      <aside>
        <section class="sheet summary">
          <div class="sub">
            <span>Subtotal</span>
            <span class="num">{money(sum)}</span>
          </div>
          <p class="fine">Prices are Coles Pialba online prices. The delivery fee is shown at checkout. Nothing is paid here.</p>
          {#if missingPrice}<p class="fine">Items without a price aren’t in the subtotal.</p>{/if}
          {#if order}
            <p class="status {order.status}" aria-live="polite">{STATUS[order.status] || order.status}</p>
            {#if order.created}<p class="when">{order.status === 'pending' ? 'Sent' : 'Updated'} {stamp(order.updated || order.created)}</p>{/if}
            {#if stale}<p class="when">The basket has changed since this was sent.</p>{/if}
          {/if}
          {#if progress}<p class="when">{progress}</p>{/if}
          {#if bulkNote}<p class="when">{bulkNote}</p>{/if}
        </section>
        <div class="actions">
          <button type="button" class="btn block" disabled={bulkBusy || sending || loading || groceryKnownEmpty} onclick={addGroceryList}>
            <Icon name="plus" size={18} />{bulkBusy ? 'Adding…' : 'Add grocery list'}
          </button>
          <button type="button" class="send" disabled={!items.length || sending || loading || bulkBusy} onclick={send}>
            <Icon name="cart" size={26} />{sending ? 'Sending…' : stale ? 'Send again' : 'Send to Coles'}
          </button>
        </div>
      </aside>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; height: 100%; padding: 6px 28px 28px; display: flex; flex-direction: column; gap: 16px; }
  .mark {
    position: absolute; left: 50%; top: 54%; z-index: 0; width: 520px; height: auto;
    transform: translate(-50%, -50%); opacity: 0.25; pointer-events: none; user-select: none;
  }
  .wrap > :not(.mark) { position: relative; z-index: 1; }
  .bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 56px; padding: 0 6px; }
  h1 { margin: 0; display: flex; align-items: baseline; gap: 14px; font-size: 30px; font-weight: 700; letter-spacing: -.02em; }
  .count { font-size: 19px; font-weight: 500; color: var(--secondary); letter-spacing: 0; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 48px; padding: 0 20px; border-radius: 24px; font-size: 19px; font-weight: 600; color: var(--red-text); }
  .btn.tint { background: var(--track); }
  .btn.block { width: 100%; height: 56px; justify-content: center; border-radius: 18px; background: var(--track); }
  .btn:disabled { opacity: .4; }
  .btn:active { opacity: .7; }
  .add { flex: 1; display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 6px 0 16px; border-radius: 28px; background: var(--sheet); }
  .plus { flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--red); color: #fff; display: grid; place-items: center; }
  input { flex: 1; min-width: 0; height: 100%; border: 0; padding: 0; background: none; font: inherit; font-size: 22px; color: var(--label); outline: none; }
  input::placeholder { color: var(--secondary); }
  .note { margin: -6px 6px 0; font-size: 17px; color: var(--secondary); }

  .body { flex: 1; min-height: 0; display: flex; align-items: stretch; gap: 16px; }
  /* The product card is only as tall as its rows, and scrolls once it reaches the pane. */
  .list { flex: 1; align-self: flex-start; max-height: 100%; min-width: 0; overflow-y: auto; padding: 6px 22px; border-radius: 22px; }
  .hint { margin: 18px 4px; font-size: 17px; color: var(--secondary); }
  .row { display: flex; align-items: center; gap: 12px; min-height: 92px; padding: 8px 0; border-bottom: 1px solid var(--sep); }
  .row:last-child { border-bottom: 0; }
  .row img, .ph { flex: none; width: 72px; height: 72px; border-radius: 14px; background: var(--ground); object-fit: contain; }
  .ph { display: grid; place-items: center; color: var(--secondary); }
  .copy { flex: 1; min-width: 0; }
  .name { display: block; font-size: 21px; font-weight: 600; overflow: hidden; max-height: 2.5em; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; font-size: 16px; color: var(--secondary); }
  .qty { flex: none; display: flex; align-items: center; gap: 4px; }
  .step, .remove { width: 48px; height: 48px; border-radius: 24px; background: var(--ground); display: grid; place-items: center; font-size: 28px; font-weight: 500; line-height: 1; color: var(--label); }
  .remove { color: var(--secondary); }
  .step:disabled { opacity: .35; }
  .step:active, .remove:active { opacity: .7; }
  .n { width: 36px; text-align: center; font-size: 22px; font-weight: 700; }
  .line { flex: none; width: 96px; text-align: right; font-size: 20px; font-weight: 700; }

  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 36px 32px 40px; }
  .empty-icon { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--track); color: var(--red-text); }
  .empty h2 { margin: 8px 0 0; font-size: 26px; font-weight: 700; }
  .empty p { margin: 0; max-width: 420px; font-size: 18px; color: var(--secondary); }

  aside { width: 360px; flex: none; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
  .summary { padding: 20px 22px 16px; border-radius: 22px; }
  .sub { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 20px; font-weight: 700; }
  .sub .num { font-size: 32px; letter-spacing: -.02em; }
  .fine, .when { margin: 10px 0 0; font-size: 16px; line-height: 1.35; color: var(--secondary); }
  .status { margin: 14px 0 0; font-size: 18px; font-weight: 700; line-height: 1.3; }
  .status.pending { color: var(--orange-text); }
  .status.filled-in-cart { color: var(--blue-text); }
  .status.done { color: var(--cal2); }
  .actions { margin-top: auto; display: flex; flex-direction: column; gap: 12px; }
  .send { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 76px; border-radius: 22px; background: var(--red); color: #fff; font-size: 24px; font-weight: 700; }
  .send:disabled { opacity: .4; }
  .send:active { opacity: .7; }
</style>
