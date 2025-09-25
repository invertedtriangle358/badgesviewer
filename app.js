/**
 * @file Nostr NIP-58 Badge Client
 * @summary Fetches and displays user profiles and their associated badges.
 */

// 定数: マジックナンバーをなくし、可読性を向上
const CONSTANTS = {
  EVENT_KINDS: {
    PROFILE: 0,
    BADGE_AWARD: 8,
    BADGE_DEFINITION: 30008,
    PROFILE_BADGES: 30009,
  },
  DEFAULT_REQUEST_LIMIT: 100,
  PLACEHOLDER_IMAGE_URL: "https://via.placeholder.com/100",
};

// DOM要素の管理
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
  profileBadges: "profileBadges" // プロフィール内に動的に生成される要素のID
};

// 接続するリレー
const RELAY_URLS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.primal.net",
  "wss://nostr.wine" 
];

// アプリケーションの状態管理
const state = {
  sockets: [],
  activeSubs: new Set(),
  pubkeyHex: "",
  badgeDefs: {}, // key: "issuer_pubkey:d_tag", value: badge_data
  received: new Set(),
  profileBadges: new Set(),
  profileRendered: false
};

// ユーティリティ関数
const Utils = {
  subId: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
  npub: (pubkey) => NostrTools.nip19.npubEncode(pubkey),
  extractBadgeData: (ev) => {
    const tags = new Map(ev.tags);
    return {
      name: tags.get("name") || "Unnamed",
      desc: tags.get("description") || "",
      img: tags.get("image") || tags.get("thumb") || "",
      issuer: ev.pubkey
    };
  }
};

// リレーとの通信を管理
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
        if (connected > 0) {
            DOM.loadButton.disabled = false;
            DOM.loginButton.disabled = false;
        }
        console.log("Connected:", url);
      };

      socket.onmessage = (e) => {
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
    console.log("Send REQ:", JSON.stringify(req));
    state.activeSubs.add(subId);
    state.sockets.forEach(s => {
      if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(req));
    });
  },

  unsubscribeAll() {
    state.activeSubs.forEach(subId => {
      const closeReq = ["CLOSE", subId];
      state.sockets.forEach(s => {
        if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(closeReq));
      });
    });
    state.activeSubs.clear();
  }
};

/**
 * 指定されたキーのバッジ定義を取得するリクエストを送信する (共通関数)
 * @param {string} key - "issuer_pubkey:d_tag" 形式のバッジキー
 */
const fetchBadgeDef = (key) => {
  if (state.badgeDefs[key]) return; // 既に取得済みなら何もしない

  const [issuer, identifier] = key.split(":");
  if (!issuer || !identifier) return;

  Relay.send({
    kinds: [CONSTANTS.EVENT_KINDS.BADGE_DEFINITION],
    authors: [issuer],
    "#d": [identifier],
    limit: 1,
  });
};

// 受信イベントの種類に応じて処理を振り分け
const Events = {
  handle(ev) {
    switch (ev.kind) {
      case CONSTANTS.EVENT_KINDS.PROFILE:
        Handlers.profile(ev);
        break;
      case CONSTANTS.EVENT_KINDS.BADGE_AWARD:
        Handlers.receivedBadge(ev);
        break;
      case CONSTANTS.EVENT_KINDS.BADGE_DEFINITION:
        Handlers.badgeDef(ev);
        break;
      case CONSTANTS.EVENT_KINDS.PROFILE_BADGES:
        Handlers.profileBadges(ev);
        break;
    }
  }
};

// 各イベントの具体的な処理
const Handlers = {
  profile(ev) {
    if (ev.pubkey !== state.pubkeyHex || state.profileRendered) return;
    state.profileRendered = true;
    UI.renderProfile(ev);
  },

  receivedBadge(ev) {
    const aTag = ev.tags.find(t => t[0] === "a");
    if (!aTag) return;

    const [kind, issuer, identifier] = aTag[1].split(":");
    if (kind !== String(CONSTANTS.EVENT_KINDS.BADGE_DEFINITION) || !issuer || !identifier) return;

    const badgeKey = `${issuer}:${identifier}`;
    state.received.add(badgeKey);
    fetchBadgeDef(badgeKey); // 共通関数でバッジ定義を要求
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
    const prefix = `${CONSTANTS.EVENT_KINDS.BADGE_DEFINITION}:`;
    ev.tags
      .filter(t => t[0] === "a" && t[1].startsWith(prefix))
      .map(t => t[1].substring(prefix.length))
      .forEach(key => {
        if (!state.profileBadges.has(key)) {
          state.profileBadges.add(key);
          fetchBadgeDef(key); // 共通関数でバッジ定義を要求
        }
      });
    UI.renderProfileBadges();
  }
};

// UIの描画関連
const UI = {
  renderProfile(ev) {
    const profile = JSON.parse(ev.content || "{}");
    const { picture, display_name, name } = profile;
    DOM.profile.innerHTML = `
      <div class="profile-header">
        <img src="${picture || CONSTANTS.PLACEHOLDER_IMAGE_URL}" width="80" height="80" alt="Profile picture">
        <div>
          <h2>${display_name || name || ev.pubkey.slice(0, 8)}</h2>
          <p><strong>npub:</strong> ${Utils.npub(ev.pubkey)}</p>
        </div>
      </div>
      <div class="mini-badges" id="${DOM.profileBadges}"></div>`;
  },

  renderBadge(key, data, isIssued) {
    const container = isIssued ? DOM.issuedBadges : DOM.receivedBadges;
    if (container.querySelector(`[data-badge="${key}"]`)) return;

    const el = document.createElement("div");
    el.className = "badge";
    el.dataset.badge = key;
    el.innerHTML = `
      <img src="${data.img || CONSTANTS.PLACEHOLDER_IMAGE_URL}" class="badge-image" alt="${data.name}">
      <div><strong>${data.name}</strong></div>
      <small>${data.desc}</small>`;
    el.onclick = () => UI.openModal(data);
    container.appendChild(el);
  },

  renderProfileBadges() {
    const container = document.getElementById(DOM.profileBadges);
    if (!container) return;

    const fragment = document.createDocumentFragment();
    state.profileBadges.forEach(key => {
      const data = state.badgeDefs[key];
      if (data) {
        const img = document.createElement("img");
        img.src = data.img || "https://via.placeholder.com/32";
        img.title = `${data.name}\n${data.desc}`;
        img.alt = data.name;
        img.onclick = (e) => {
          e.stopPropagation();
          UI.openModal(data);
        };
        fragment.appendChild(img);
      }
    });
    container.innerHTML = "";
    container.appendChild(fragment);
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

// アプリケーション全体の制御
const App = {
  init() {
    DOM.loadButton.onclick = () => this.loadFromInput();
    DOM.loginButton.onclick = () => this.login();
    DOM.npubInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.loadFromInput();
    });
    Relay.connectAll();
  },

  loadFromInput() {
    const npub = DOM.npubInput.value.trim();
    if (!npub) return alert("npubを入力してください");
    try {
      const { type, data } = NostrTools.nip19.decode(npub);
      if (type !== "npub") throw new Error("Invalid npub format.");
      this.loadAll(data);
    } catch (e) {
      alert(`npubのデコードに失敗しました: ${e.message}`);
    }
  },

  async login() {
    if (!window.nostr) return alert("Nostr拡張機能が見つかりません。");
    try {
      const pubkey = await window.nostr.getPublicKey();
      this.loadAll(pubkey);
    } catch(e) {
      alert(`ログインに失敗しました: ${e.message}`)
    }
  },
  
  resetStateAndUI() {
    Relay.unsubscribeAll();
    Object.assign(state, {
        badgeDefs: {},
        profileRendered: false,
    });
    state.received.clear();
    state.profileBadges.clear();
    DOM.profile.innerHTML = "";
    DOM.receivedBadges.innerHTML = "";
    DOM.issuedBadges.innerHTML = "";
  },

  loadAll(pubkeyHex) {
    this.resetStateAndUI();
    state.pubkeyHex = pubkeyHex;
    DOM.status.textContent = `${Utils.npub(pubkeyHex).slice(0, 16)}... 読み込み中...`;

    // プロフィール (Kind 0)
    Relay.send({ kinds: [CONSTANTS.EVENT_KINDS.PROFILE], authors: [pubkeyHex], limit: 1 });
    // 授与されたバッジ (Kind 8)
    Relay.send({ kinds: [CONSTANTS.EVENT_KINDS.BADGE_AWARD], "#p": [pubkeyHex], limit: CONSTANTS.DEFAULT_REQUEST_LIMIT });
    // 発行したバッジ定義 (Kind 30008)
    Relay.send({ kinds: [CONSTANTS.EVENT_KINDS.BADGE_DEFINITION], authors: [pubkeyHex], limit: CONSTANTS.DEFAULT_REQUEST_LIMIT });
    // プロフィールバッジリスト (Kind 30009)
    Relay.send({ kinds: [CONSTANTS.EVENT_KINDS.PROFILE_BADGES], authors: [pubkeyHex], limit: 1 });
  }
};

// グローバルスコープに関数を公開 (HTMLから呼び出すため)
const NostrApp = { ...App, closeModal: UI.closeModal };

// アプリケーションを初期化
App.init();
