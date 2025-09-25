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
  "wss://relay-jp.nostr.wirednet.jp",
];

const NostrApp = {
  sockets: [],
  activeSubscriptions: new Set(),
  currentPubkeyHex: "",
  badgeDefs: {},
  receivedBadgeKeys: {},
  profileBadgeKeys: [],
  hasRenderedProfile: false,

  init() {
    DOM.loadButton.addEventListener("click", () => this.loadFromNpub());
    DOM.loginButton.addEventListener("click", () => this.loginWithNostr());
    DOM.npubInput.addEventListener("keypress", e => { if (e.key === 'Enter') this.loadFromNpub(); });
    this.connectRelays();
  },

  connectRelays() {
    let connectedCount = 0;
    DOM.status.textContent = `接続中... (0/${RELAY_URLS.length})`;

    RELAY_URLS.forEach(url => {
      const socket = new WebSocket(url);
      this.sockets.push(socket);

      socket.onopen = () => {
        connectedCount++;
        DOM.status.textContent = `リレーに接続しました (${connectedCount}/${RELAY_URLS.length})`;
        DOM.loadButton.disabled = false;
        DOM.loginButton.disabled = false;
        console.log("Relay connected:", url);
      };

      socket.onclose = () => console.log("Relay disconnected:", url);
      socket.onerror = e => console.error("Relay error:", url, e);

      socket.onmessage = e => {
        try {
          const [type, subId, event] = JSON.parse(e.data);
          if (type === "EVENT") this.handleEvent(event);
        } catch (err) { console.error("Relay message parse error:", err); }
      };
    });
  },

  generateSubId(prefix) {
    return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
  },

  sendRequest(filter) {
    const subId = this.generateSubId(filter.kinds.join('-'));
    const req = ["REQ", subId, filter];
    this.activeSubscriptions.add(subId);
    console.log("Sending REQ:", req);
    this.sockets.forEach(s => {
      if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(req));
    });
  },

  unsubscribeAll() {
    if (this.activeSubscriptions.size === 0) return;
    console.log("Closing all subscriptions:", this.activeSubscriptions);
    this.activeSubscriptions.forEach(subId => {
      const closeReq = ["CLOSE", subId];
      this.sockets.forEach(s => {
        if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(closeReq));
      });
    });
    this.activeSubscriptions.clear();
  },

  loadAll(pubkeyHex) {
    this.unsubscribeAll();
    DOM.profile.innerHTML = "";
    DOM.receivedBadges.innerHTML = "";
    DOM.issuedBadges.innerHTML = "";
    this.badgeDefs = {};
    this.receivedBadgeKeys = {};
    this.profileBadgeKeys = [];
    this.currentPubkeyHex = pubkeyHex;
    this.hasRenderedProfile = false;
    
    DOM.status.textContent = `${NostrTools.nip19.npubEncode(pubkeyHex).slice(0, 16)}... の情報を読み込み中...`;

    this.sendRequest({ kinds: [0], authors: [pubkeyHex], limit: 1 });
    this.sendRequest({ kinds: [8], "#p": [pubkeyHex] });
    this.sendRequest({ kinds: [30008], authors: [pubkeyHex] });
    this.sendRequest({ kinds: [30009], authors: [pubkeyHex], limit: 1 });
  },

  loginWithNostr() {
    if (!window.nostr) {
      alert("Nostr Login対応拡張が見つかりません");
      return;
    }
    window.nostr.getPublicKey().then(p => {
      if (p) this.loadAll(p);
    }).catch(e => {
      console.error("Login failed", e);
      alert("Nostr Login失敗");
    });
  },

  loadFromNpub() {
    const npub = DOM.npubInput.value.trim();
    if (!npub) return alert("npubを入力してください");
    try {
      const { type, data } = NostrTools.nip19.decode(npub);
      if (type !== "npub") throw new Error("npub形式ではありません");
      this.loadAll(data);
    } catch (e) {
      console.error("npub decode failed", e);
      alert("npub decode failed");
    }
  },

  handleEvent(event) {
    switch(event.kind){
      case 0:
        if(event.pubkey === this.currentPubkeyHex && !this.hasRenderedProfile) {
          this.hasRenderedProfile = true;
          this.renderProfile(event);
        }
        break;
      case 8:
        if(event.tags.some(t => t[0] === "p" && t[1] === this.currentPubkeyHex)) this.processReceivedBadge(event);
        break;
      case 30008: this.processBadgeDefinition(event); break;
      case 30009:
        if(event.pubkey === this.currentPubkeyHex) this.processProfileBadges(event);
        break;
    }
  },
  
  renderProfile(event){
    DOM.status.textContent = "プロフィール情報を表示しました。";
    const profile = JSON.parse(event.content);
    DOM.profile.innerHTML=`
    <div class="profile-header">
      <img src="${profile.picture || 'https://via.placeholder.com/100'}" width="100" alt="Profile Picture">
      <div>
        <h2>${profile.display_name || profile.name || event.pubkey.slice(0, 8)}</h2>
        <p><strong>npub:</strong> ${NostrTools.nip19.npubEncode(event.pubkey)}</p>
        <p>${profile.about || '自己紹介はありません。'}</p>
      </div>
    </div>
    <div class="mini-badges" id="${DOM.profileBadges}"></div>`;

    const badgeKeysFromProfile = event.tags
      .filter(t => t[0] === 'a' && t[1]?.startsWith('30008:'))
      .map(t => t[1].substring('30008:'.length));
    
    if (badgeKeysFromProfile.length > 0) {
        DOM.status.textContent = "プロフィールバッジを検出。定義を取得中...";
    }
    this.updateProfileBadges(badgeKeysFromProfile);
    this.renderProfileBadges();
  },

  processReceivedBadge(event){
    const aTag=event.tags.find(t=>t[0]==="a"); if(!aTag || !aTag[1]) return;
    const parts=aTag[1].split(":"); if(parts.length!==3||parts[0]!=="30008") return;
    const [,issuer,identifier]=parts;
    const badgeKey=`${issuer}:${identifier}`;
    this.receivedBadgeKeys[badgeKey]=true;

    if(this.badgeDefs[badgeKey]) {
      this.renderBadge(issuer,identifier,this.badgeDefs[badgeKey],false);
    } else {
      this.sendRequest({ kinds: [30008], authors: [issuer], "#d": [identifier], limit: 1 });
    }
  },

  processBadgeDefinition(event){
    const id = event.tags.find(t => t[0] === "d")?.[1]; if (!id) return;
    const badgeKey = `${event.pubkey}:${id}`;
    if (this.badgeDefs[badgeKey]) return;

    const badgeData={
      name: event.tags.find(t => t[0] === "name")?.[1] || "Unnamed Badge",
      desc: event.tags.find(t => t[0] === "description")?.[1] || "",
      img: event.tags.find(t => t[0] === "image")?.[1] || event.tags.find(t => t[0] === "thumb")?.[1] || "",
      issuer: event.pubkey
    };
    this.badgeDefs[badgeKey] = badgeData;
    
    DOM.status.textContent = `バッジ定義「${badgeData.name}」を取得しました。`;

    if(event.pubkey === this.currentPubkeyHex) this.renderBadge(event.pubkey, id, badgeData, true);
    if(this.receivedBadgeKeys[badgeKey]) this.renderBadge(event.pubkey, id, badgeData, false);
    if(this.profileBadgeKeys.includes(badgeKey)) this.renderProfileBadges();
  },
  
  processProfileBadges(event){
    const newBadgeKeys = event.tags
      .filter(t => t[0] === 'a' && t[1]?.startsWith('30008:'))
      .map(t => t[1].substring('30008:'.length));
    
    this.updateProfileBadges(newBadgeKeys);
    this.renderProfileBadges();
  },
  
  updateProfileBadges(newKeys) {
    if (!newKeys || newKeys.length === 0) return;
    const currentKeys = new Set(this.profileBadgeKeys);
    const addedKeys = [];
    newKeys.forEach(key => {
        if (!currentKeys.has(key)) {
            currentKeys.add(key);
            addedKeys.push(key);
        }
    });
    this.profileBadgeKeys = Array.from(currentKeys);
    addedKeys.forEach(key => {
        if (!this.badgeDefs[key]) {
            const [issuer, identifier] = key.split(':');
            if (issuer && identifier) {
               this.sendRequest({ kinds: [30008], authors: [issuer], "#d": [identifier], limit: 1 });
            }
        }
    });
  },

  renderProfileBadges() {
    const profileDiv = document.getElementById(DOM.profileBadges);
    if (!profileDiv) return;
    profileDiv.innerHTML = '';
    this.profileBadgeKeys.forEach(badgeKey => {
      const data = this.badgeDefs[badgeKey];
      if (data) {
        const mini = document.createElement("img");
        mini.src = data.img || 'https://via.placeholder.com/32';
        mini.title = `${data.name}\n${data.desc}`;
        mini.onclick = e => { e.stopPropagation(); this.openModal(data.img, data.name, data.desc); };
        profileDiv.appendChild(mini);
      }
    });
  },

  renderBadge(issuer, id, data, isIssued) {
    const container = isIssued ? DOM.issuedBadges : DOM.receivedBadges;
    const badgeKey = `${issuer}:${id}`;
    if (container.querySelector(`[data-badge-key="${badgeKey}"]`)) return;
    
    const div = document.createElement("div");
    div.className = "badge";
    div.dataset.badgeKey = badgeKey;
    div.innerHTML = `
      <img src="${data.img || 'https://via.placeholder.com/100'}" class="badge-image" alt="${data.name}">
      <div><strong>${data.name}</strong></div>
      <small>${data.desc.substring(0, 30)}${data.desc.length > 30 ? '...' : ''}</small>`;
    div.onclick = () => this.openModal(data.img, data.name, data.desc);
    container.appendChild(div);
  },

  openModal(img, name, desc) {
    DOM.modalImg.src = img || 'https://via.placeholder.com/200';
    DOM.modalName.textContent = name;
    DOM.modalDesc.textContent = desc;
    DOM.modal.style.display = "flex";
  },

  closeModal() {
    DOM.modal.style.display = "none";
  }
};

NostrApp.init();
