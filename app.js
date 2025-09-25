const DOM = {
  loadButton: document.getElementById("loadButton"),
  loginButton: document.getElementById("nostrLoginButton"),
  npubInput: document.getElementById("npubInput"),
  status: document.getElementById("status"),
  profile: document.getElementById("profile"),
  receivedBadges: document.getElementById("receivedBadges"),
  issuedBadges: document.getElementById("issuedBadges"),
  modal: document.getElementById("badgeModal"),
  modalImg: document.getElementById("modalImg"),
  modalName: document.getElementById("modalName"),
  modalDesc: document.getElementById("modalDesc"),
  profileBadges: "profileBadges"
};

const RELAY_URLS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp"
];

const state = {
  sockets: [],
  activeSubs: new Set(),
  pubkeyHex: "",
  badgeDefs: {},
  received: new Set(),
  profileBadges: new Set(),
  profileRendered: false
};

const Utils = {
  subId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  },
  npub(pubkey) {
    return NostrTools.nip19.npubEncode(pubkey);
  },
  extractBadgeData(ev) {
    const name = ev.tags.find(t => t[0] === "name")?.[1] || "Unnamed";
    const desc = ev.tags.find(t => t[0] === "description")?.[1] || "";
    const img =
      ev.tags.find(t => t[0] === "image")?.[1] ||
      ev.tags.find(t => t[0] === "thumb")?.[1] ||
      ev.tags.find(t => t[0] === "icon")?.[1] ||
      "";
    return { name, desc, img, issuer: ev.pubkey };
  }
};

const Relay = {
  connectAll() {
    let connected = 0;
    DOM.status.textContent = `接続中... (0/${RELAY_URLS.length})`;

    RELAY_URLS.forEach(url => {
      const socket = new WebSocket(url);
      state.sockets.push(socket);

      socket.onopen = () => {
        connected++;
        DOM.status.textContent = `接続 (${connected}/${RELAY_URLS.length})`;
        DOM.loadButton.disabled = false;
        DOM.loginButton.disabled = false;
        console.log("Connected:", url);
      };

      socket.onmessage = e => {
        try {
          const [type, , event] = JSON.parse(e.data);
          if (type === "EVENT") Events.handle(event);
        } catch (err) {
          console.error("Parse error:", err);
        }
      };
    });
  },

  send(filter) {
  const subId = Utils.subId(filter.kinds.join('-'));
  const req = ["REQ", subId, filter];
  console.log("Send REQ:", JSON.stringify(req)); // ★確認ログ
  state.activeSubs.add(subId);
  state.sockets.forEach(s => {
    if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(req));
  });
},

  unsubscribeAll() {
    if (state.activeSubs.size === 0) return;
    state.activeSubs.forEach(subId => {
      const closeReq = ["CLOSE", subId];
      state.sockets.forEach(s => {
        if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(closeReq));
      });
    });
    state.activeSubs.clear();
  }
};

const Events = {
  handle(ev) {
    switch (ev.kind) {
      case 0:
        Handlers.profile(ev);
        break;
      case 8:
        Handlers.receivedBadge(ev);
        break;
      case 30008:
        Handlers.badgeDef(ev);
        break;
      case 30009:
        Handlers.profileBadges(ev);
        break;
    }
  }
};

const Handlers = {
  profile(ev) {
    if (ev.pubkey !== state.pubkeyHex || state.profileRendered) return;
    state.profileRendered = true;
    UI.renderProfile(ev);
  },

  receivedBadge(ev) {
    const aTag = ev.tags.find(t => t[0] === "a");
    if (!aTag) return;
    const parts = aTag[1].split(":");
    if (parts.length !== 3 || parts[0] !== "30008") return;

    const [, issuer, identifier] = parts;
    const badgeKey = `${issuer}:${identifier}`;
    state.received.add(badgeKey);

    if (state.badgeDefs[badgeKey]) {
      UI.renderBadge(badgeKey, state.badgeDefs[badgeKey], false);
    } else {
      Relay.send({ kinds: [30008], authors: [issuer], "#d": [identifier], limit: 1 });
    }
  },

  badgeDef(ev) {
    const id = ev.tags.find(t => t[0] === "d")?.[1];
    if (!id) return;

    const key = `${ev.pubkey}:${id}`;
    if (state.badgeDefs[key]) return;

    state.badgeDefs[key] = Utils.extractBadgeData(ev);

    if (ev.pubkey === state.pubkeyHex) UI.renderBadge(key, state.badgeDefs[key], true);
    if (state.received.has(key)) UI.renderBadge(key, state.badgeDefs[key], false);
    if (state.profileBadges.has(key)) UI.renderProfileBadges();
  },

  profileBadges(ev) {
    const newKeys = ev.tags
      .filter(t => t[0] === "a" && t[1].startsWith("30008:"))
      .map(t => t[1].slice("30008:".length));

    newKeys.forEach(key => {
      if (!state.profileBadges.has(key)) {
        state.profileBadges.add(key);
        if (!state.badgeDefs[key]) {
          const [issuer, identifier] = key.split(":");
          Relay.send({ kinds: [30008], authors: [issuer], "#d": [identifier], limit: 1 });
        }
      }
    });

    UI.renderProfileBadges();
  }
};

const UI = {
  renderProfile(ev) {
    const profile = JSON.parse(ev.content || "{}");
    DOM.profile.innerHTML = `
      <div class="profile-header">
        <img src="${profile.picture || "https://via.placeholder.com/100"}" width="80" height="80">
        <div>
          <h2>${profile.display_name || profile.name || ev.pubkey.slice(0, 8)}</h2>
          <p><strong>npub:</strong> ${Utils.npub(ev.pubkey)}</p>
        </div>
      </div>
      <div class="mini-badges" id="${DOM.profileBadges}"></div>
    `;
  },

  renderBadge(key, data, isIssued) {
    const container = isIssued ? DOM.issuedBadges : DOM.receivedBadges;
    if (container.querySelector(`[data-badge="${key}"]`)) return;

    const div = document.createElement("div");
    div.className = "badge";
    div.dataset.badge = key;
    div.innerHTML = `
      <img src="${data.img || "https://via.placeholder.com/100"}" class="badge-image">
      <div><strong>${data.name}</strong></div>
      <small>${data.desc}</small>
    `;
    div.onclick = () => UI.openModal(data);
    container.appendChild(div);
  },

  renderProfileBadges() {
    const wrap = document.getElementById(DOM.profileBadges);
    if (!wrap) return;
    wrap.innerHTML = "";
    state.profileBadges.forEach(key => {
      const data = state.badgeDefs[key];
      if (data) {
        const img = document.createElement("img");
        img.src = data.img || "https://via.placeholder.com/32";
        img.title = `${data.name}\n${data.desc}`;
        img.onclick = e => {
          e.stopPropagation();
          UI.openModal(data);
        };
        wrap.appendChild(img);
      }
    });
  },

  openModal(data) {
    DOM.modalImg.src = data.img || "https://via.placeholder.com/200";
    DOM.modalName.textContent = data.name;
    DOM.modalDesc.textContent = data.desc;
    DOM.modal.style.display = "flex";
  },

  closeModal() {
    DOM.modal.style.display = "none";
  }
};

const App = {
  init() {
    DOM.loadButton.onclick = () => this.loadFromInput();
    DOM.loginButton.onclick = () => this.login();
    DOM.npubInput.addEventListener("keypress", e => {
      if (e.key === "Enter") this.loadFromInput();
    });
    Relay.connectAll();
  },

  loadFromInput() {
    const npub = DOM.npubInput.value.trim();
    if (!npub) return alert("npubを入力してください");
    try {
      const { type, data } = NostrTools.nip19.decode(npub);
      if (type !== "npub") throw new Error();
      this.loadAll(data);
    } catch {
      alert("npub decode failed");
    }
  },

  login() {
    if (!window.nostr) return alert("Nostr Login未対応");
    window.nostr.getPublicKey().then(pubkey => this.loadAll(pubkey));
  },

  loadAll(pubkeyHex) {
    Relay.unsubscribeAll();
    state.pubkeyHex = pubkeyHex;
    state.badgeDefs = {};
    state.received.clear();
    state.profileBadges.clear();
    state.profileRendered = false;
    DOM.profile.innerHTML = "";
    DOM.receivedBadges.innerHTML = "";
    DOM.issuedBadges.innerHTML = "";

    DOM.status.textContent = `${Utils.npub(pubkeyHex).slice(0, 16)}... 読み込み中...`;

    Relay.send({ kinds: [0], authors: [pubkeyHex], limit: 1 });
    Relay.send({ kinds: [8], "#p": [pubkeyHex] });
    Relay.send({ kinds: [30008], authors: [pubkeyHex] });
    Relay.send({ kinds: [30009], authors: [pubkeyHex], limit: 1 });
  }
};

NostrApp = { ...App, closeModal: UI.closeModal };
App.init();
