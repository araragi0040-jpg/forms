// app.js（完全版）
// --------------------
const openedAtMs = Date.now();

// ★Vercel経由で叩く
const API_BASE = "/api/forms";

// 埋め込みGoogleカレンダー表示設定
// false：非表示 / true：表示
const SHOW_EMBED_CALENDAR = true;

let lastGlobalErrorMsg = "";
let lastGlobalErrorAt = 0;

function isIgnorableBrowserError_(raw){
  const s = String(raw || "");
  return (
    s.includes("ResizeObserver loop completed with undelivered notifications") ||
    s.includes("ResizeObserver loop limit exceeded")
  );
}

function reportGlobalError_(label, rawMessage, detail){
  if (isIgnorableBrowserError_(rawMessage)) return;
  
  const debugMsg = `${label}:\n${rawMessage || "不明なエラー"}`;
  const userMsg = "エラーが発生しました。ページを再読み込みして、もう一度お試しください。";
  
  const now = Date.now();
  // 同一エラーの短時間連打でDOM更新が連鎖しないように抑制
  if (debugMsg === lastGlobalErrorMsg && (now - lastGlobalErrorAt) < 1500) return;
  
  lastGlobalErrorMsg = debugMsg;
  lastGlobalErrorAt = now;
  
  console.error(debugMsg, detail);
  showError(userMsg);
}

window.addEventListener("error", (e) => {
  const rawMessage = `${e?.message || ""}\n${e?.filename || ""}:${e?.lineno || ""}`;
  reportGlobalError_("JSエラー", rawMessage, e?.error);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e?.reason?.message || e?.reason;
  reportGlobalError_("Promiseエラー", reason, e?.reason);
});

const state = {
  pageIndex: 0,
  server: { termsVersion:"", minSubmitSeconds:3 },
  formToken: "",
  availableSlots: [],
  slotsLoading: false,
  slotsDate: "",
  answers: {
    email: "",
    name: "",
    postal: "",
    address: "",
    phone: "",

    shootingContents: [],
    shootingContentsOther: "",

    shootingPlace: "",
    participants: "",
    mainPersonName: "",
    preferredDate: "",
    preferredTime: "",

    dressingNeed: "",
    dressingDetail: "",
    dressingPlace: "",
    dressingAddressChoice: "",
    dressingAddressOther: "",
    parkingSpace: "",

    kimonoRentalOther: "",
    kimonoRentalItems: [],

    planType: "",
    planStudio: "",
    planOutcall: "",
    planSet: [],

    options: [],
    paymentMethod: "",
    howKnew: "",
    howKnewOther: "",
    message: "",

    privacyAgree: false,
    cancelAgree: false,
  }
};

// DOM
const pageRoot = document.getElementById("pageRoot");
const errBox = document.getElementById("errBox");
const btnBack = document.getElementById("btnBack");
const btnNext = document.getElementById("btnNext");
const barInner = document.getElementById("barInner");
const stepText = document.getElementById("stepText");
const overlay = document.getElementById("overlay");
const doneCard = document.getElementById("doneCard");
const pageCard = document.getElementById("pageCard");
const doneId = document.getElementById("doneId");

// ====== ページ定義 ======
const pages = [
  { title:"① 連絡先", desc:"ご連絡のために必要な情報です。", fields:["email","name","postal","address","phone"] },
  { title:"② 撮影の基本情報", desc:"撮影内容とご希望を教えてください。", fields:["shootingContents","shootingPlace","participants","mainPersonName"] },
  { title:"③ 着付け・レンタル", desc:"必要な場合だけ追加項目が出ます。", fields:["dressingNeed","dressingDetail","dressingPlace","dressingAddressChoice","parkingSpace","kimonoRental"] },
  { title:"④ プラン選択", desc:"プランを選ぶと、次の選択肢が出ます。", fields:["planType","planStudio","planOutcall","planSet","options"] },
  { title:"⑤ 仕上げ（確認＆同意）", desc:"送信前に内容確認と同意をお願いします。", fields:["paymentMethod","howKnew","message","agreements","review"] }
];

// セット候補
const PLAN_STUDIO = [
  "【１番人気🥇】プレミアムプラン (全データ/A4木製ガラスパネル) ¥65,000→¥59,800",
  "スタンダードプラン (全データ込み) ¥45,000",
  "ライトプラン (5データのみ) ¥35,000 ※データはお客様セレクト"
];
const PLAN_OUTCALL = [
  "プレミアムプラン (全データ/2L木製ガラスパネル/アルバム10P Mサイズ) ¥80,000→¥69,800",
  "【１番人気🥇】スタンダードプラン(全データ/2L木製ガラスパネル/2面台紙) ¥70,000→¥59,800",
  "スマートプラン(全データ/2L木製ガラスパネル) ¥45,000"
];

// ====== 初期化 ======
(async function init(){
  // まずは仮設定で即表示
  state.server = { termsVersion:"", minSubmitSeconds:3 };
  state.formToken = "";
  state.availableSlots = [];
  state.slotsLoading = false;
  state.slotsDate = "";
  render();
  ensureHoneypotInput();

  try {
    const res = await fetch(`${API_BASE}?action=config`, {
      method: "GET",
      cache: "no-store"
    });

    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn("configがJSONではありません:", text.slice(0, 120));
      showError("初期化に失敗しました。ページを更新してから再度お試しください。");
      return;
    }

    if (!json.ok) {
      console.warn("config取得失敗:", json.message);
      showError("初期化に失敗しました。ページを更新してから再度お試しください。");
      return;
    }

    const data = json.data || {};
    const { formToken, ...serverData } = data;
    state.server = { ...state.server, ...serverData };
    state.formToken = typeof formToken === "string" ? formToken : "";
    render();

  } catch (e) {
    console.warn("config取得エラー:", e?.message || e);
    showError("初期化に失敗しました。ページを更新してから再度お試しください。");
  }
})();

// ====== 便利関数 ======
function showError(msg){ errBox.style.display="block"; errBox.textContent=msg; }
function clearError(){ errBox.style.display="none"; errBox.textContent=""; }
function toggleLoading(on){ overlay.style.display = on ? "flex" : "none"; }

function ensureHoneypotInput(){
  if (document.querySelector('input[name="website"][data-honeypot="1"]')) return;

  const hpInput = document.createElement("input");
  hpInput.type = "text";
  hpInput.name = "website";
  hpInput.autocomplete = "off";
  hpInput.tabIndex = -1;
  hpInput.setAttribute("aria-hidden", "true");
  hpInput.setAttribute("data-honeypot", "1");
  hpInput.style.cssText = "position:absolute;left:-9999px;opacity:0;height:0;width:0;border:0;padding:0;";
  pageRoot.parentElement.appendChild(hpInput);
}

function scrollToTopAfterRender(){
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function rerenderAll(){
  cleanupByBranch();
  render();
}

let slotsRequestSeq = 0;

function normalizeSlots(list){
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => String(v || "").trim())
    .filter((v) => /^\d{2}:\d{2}$/.test(v))
    .sort((a, b) => {
      const [ah, am] = a.split(":").map(Number);
      const [bh, bm] = b.split(":").map(Number);
      return (ah * 60 + am) - (bh * 60 + bm);
    });
}

async function fetchSlots(dateStr){
  const date = String(dateStr || "").trim();
  if (!date) {
    state.availableSlots = [];
    state.slotsLoading = false;
    state.slotsDate = "";
    state.answers.preferredTime = "";
    render();
    return;
  }

  const reqId = ++slotsRequestSeq;
  state.slotsLoading = true;
  state.slotsDate = date;
  state.availableSlots = [];
  state.answers.preferredTime = "";
  render();

  try {
    const res = await fetch(`${API_BASE}?action=slots&date=${encodeURIComponent(date)}`, {
      method: "GET",
      cache: "no-store"
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("空き枠情報の取得に失敗しました。");
    }
    if (!json.ok) throw new Error(json.message || "空き枠情報の取得に失敗しました。");

    if (reqId !== slotsRequestSeq) return;
    state.availableSlots = normalizeSlots(json.slots);

  } catch (e) {
    if (reqId !== slotsRequestSeq) return;
    state.availableSlots = [];
    showError(`空き枠の取得に失敗しました。\n${e && e.message ? e.message : e}`);
  } finally {
    if (reqId === slotsRequestSeq) {
      state.slotsLoading = false;
      render();
    }
  }
}

// 電話：数字だけ
function formatPhone(raw){
  return String(raw||"").replace(/\D/g,"");
}

// 分岐の不要値を掃除
function cleanupByBranch(){
  const a = state.answers;

  // options 表示順固定
  const optMaster = [
    "① A4木製ガラスパネル (305×220mm) ¥20,000",
    "② 2面アルバム (216×216mm) ¥25,000",
    "③ 3面アルバム (216×216mm) ¥30,000",
    "④ アルバム10P M (216×216mm) ¥35,000",
    "⑤ アルバム10P L (305×305mm) ¥40,000",
    "⑥ クリスタルアルバム10P (301×299mm) ¥55,000"
  ];
  if (Array.isArray(a.options)) {
    a.options = a.options
      .filter(x => optMaster.includes(x))
      .sort((x, y) => optMaster.indexOf(x) - optMaster.indexOf(y));
  }

  // 着付け無し
  if (a.dressingNeed === "無し") {
    a.dressingDetail = "";
    a.dressingPlace = "";
    a.dressingAddressChoice = "";
    a.dressingAddressOther = "";
    a.parkingSpace = "";
  } else {
    a.preferredDate = "";
    a.preferredTime = "";
    state.availableSlots = [];
    state.slotsLoading = false;
    state.slotsDate = "";
  }

  // 当写真館なら住所/駐車なし
  if (a.dressingPlace === "当写真館") {
    a.dressingAddressChoice = "";
    a.dressingAddressOther = "";
    a.parkingSpace = "";
  }

  // 着物レンタル：無し排他
  {
    const items = a.kimonoRentalItems || [];
    if (items.includes("無し")) {
      a.kimonoRentalItems = ["無し"];
      a.kimonoRentalOther = "";
    }
    if (!items.includes("その他")) a.kimonoRentalOther = "";
  }

  // プラン分岐
  if (!String(a.planType||"").startsWith("写真館撮影")) a.planStudio = "";
  if (!String(a.planType||"").startsWith("出張撮影")) a.planOutcall = "";
  if (!String(a.planType||"").startsWith("セットプラン")) a.planSet = [];
}

// ====== UI部品 ======
function makeInputBox(title, required, hint){
  const box = document.createElement("div");
  box.className = "q";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  if (required){
    const r = document.createElement("span");
    r.className = "req";
    r.textContent = "必須";
    t.appendChild(r);
  }
  box.appendChild(t);
  if (hint){
    const h = document.createElement("div");
    h.className = "h";
    h.textContent = hint;
    box.appendChild(h);
  }
  return box;
}

function renderRadio(key, title, required, options, hint){
  const box = makeInputBox(title, required, hint);
  const wrap = document.createElement("div");
  wrap.className = "choices";

  options.forEach(opt=>{
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = key;
    input.value = opt;
    input.checked = (state.answers[key] === opt);
    input.addEventListener("change", ()=>{
      state.answers[key] = opt;
      rerenderAll();
    });
    const span = document.createElement("div");
    span.textContent = opt;
    label.appendChild(input);
    label.appendChild(span);
    wrap.appendChild(label);
  });

  box.appendChild(wrap);
  return box;
}

function renderCheckbox(key, title, required, options, hint, other){
  const box = makeInputBox(title, required, hint);
  const wrap = document.createElement("div");
  wrap.className = "choices";
  const cur = new Set(state.answers[key] || []);

  options.forEach(opt=>{
    const value = (typeof opt === "object") ? opt.value : opt;
    const labelText = (typeof opt === "object") ? opt.label : opt;

    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = cur.has(value);

    input.addEventListener("change", ()=>{
      if (input.checked) cur.add(value);
      else cur.delete(value);
      state.answers[key] = Array.from(cur);
      rerenderAll();
    });

    const span = document.createElement("div");
    span.textContent = labelText;
    label.appendChild(input);
    label.appendChild(span);
    wrap.appendChild(label);
  });

  box.appendChild(wrap);

  if (other){
    const isOther = (state.answers[key] || []).includes("その他");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = other.placeholder || "その他の内容";
    inp.value = state.answers[other.key] || "";
    inp.disabled = !isOther;
    inp.style.opacity = isOther ? 1 : 0.6;
    inp.addEventListener("input", ()=> state.answers[other.key] = inp.value);
    box.appendChild(inp);
  }
  return box;
}

// ====== render ======
function render(){
  //clearError();
  cleanupByBranch();

  const totalPages = pages.length;
  if (state.pageIndex < 0) state.pageIndex = 0;
  if (state.pageIndex > totalPages - 1) state.pageIndex = totalPages - 1;

  stepText.textContent = `${state.pageIndex + 1} / ${totalPages}`;
  barInner.style.width = `${Math.round(((state.pageIndex + 1) / totalPages) * 100)}%`;

  btnBack.disabled = state.pageIndex === 0;
  btnBack.style.opacity = btnBack.disabled ? 0.6 : 1;
  btnNext.textContent = (state.pageIndex === totalPages - 1) ? "送信" : "次へ";

  pageRoot.innerHTML = "";

  const page = pages[state.pageIndex];
  const h2 = document.createElement("h2"); h2.textContent = page.title;
  const d = document.createElement("div"); d.className="desc"; d.textContent = page.desc;
  pageRoot.appendChild(h2);
  pageRoot.appendChild(d);

  // ① 連絡先
  if (page.fields.includes("email") || page.fields.includes("name")){
    const grid = document.createElement("div"); grid.className="grid";

    if (page.fields.includes("email")){
      const box = makeInputBox("メールアドレス", true, "自動返信メールをお送りします");
      const input = document.createElement("input"); input.type="email";
      input.value = state.answers.email;
      input.addEventListener("input", ()=> state.answers.email = input.value);
      box.appendChild(input);
      grid.appendChild(box);
    }

    if (page.fields.includes("name")){
      const box = makeInputBox("お名前", true, "");
      const input = document.createElement("input"); input.type="text";
      input.value = state.answers.name;
      input.addEventListener("input", ()=> state.answers.name = input.value);
      box.appendChild(input);
      grid.appendChild(box);
    }
    pageRoot.appendChild(grid);
  }

  if (page.fields.includes("postal") || page.fields.includes("address") || page.fields.includes("phone")){
    const grid = document.createElement("div"); grid.className="grid";

    if (page.fields.includes("postal")){
      const box = makeInputBox("郵便番号", true, "例：123-4567");
      const input = document.createElement("input"); input.type="text";
      input.value = state.answers.postal;
      input.addEventListener("input", ()=> state.answers.postal = input.value);
      box.appendChild(input);
      grid.appendChild(box);
    }

    if (page.fields.includes("phone")){
      const box = makeInputBox("お電話番号", true, "ハイフン不要");
      const input = document.createElement("input"); input.type="tel";
      input.value = state.answers.phone;
      input.addEventListener("input", ()=> state.answers.phone = input.value);
      input.addEventListener("blur", ()=>{
        state.answers.phone = formatPhone(input.value);
        input.value = state.answers.phone;
      });
      box.appendChild(input);
      grid.appendChild(box);
    }
    pageRoot.appendChild(grid);

    if (page.fields.includes("address")){
      const box = makeInputBox("ご住所", true, "");
      const input = document.createElement("input"); input.type="text";
      input.value = state.answers.address;
      input.addEventListener("input", ()=> state.answers.address = input.value);
      box.appendChild(input);
      pageRoot.appendChild(box);
    }
  }

  // ② 撮影内容
  if (page.fields.includes("shootingContents")){
    pageRoot.appendChild(
      renderCheckbox(
        "shootingContents",
        "撮影内容（複数選択）",
        true,
        ["家族撮影","お宮参り撮影","バースデー撮影","七五三撮影","入学園/卒学園撮影","成人式撮影","還暦撮影(米寿なども含む)","ペット撮影","ウェディング前撮り","挙式披露宴撮影","その他"],
        "当てはまるものをすべて選択してください。",
        { key:"shootingContentsOther", placeholder:"その他の内容" }
      )
    );
  }

  if (page.fields.includes("shootingPlace")){
    const box = makeInputBox("撮影場所", true, "例：写真館、枚岡神社、石切神社、自宅、〇〇公園 など");
    const input = document.createElement("input"); input.type="text";
    input.value = state.answers.shootingPlace;
    input.addEventListener("input", ()=> state.answers.shootingPlace = input.value);
    box.appendChild(input);
    pageRoot.appendChild(box);
  }

  if (page.fields.includes("participants") || page.fields.includes("mainPersonName")){
    const grid = document.createElement("div"); grid.className="grid";

    if (page.fields.includes("participants")){
      const box = makeInputBox("ご参加人数", true, "例：5名（父/母/主役1歳女の子/祖父/祖母）");
      const input = document.createElement("input"); input.type="text";
      input.value = state.answers.participants;
      input.addEventListener("input", ()=> state.answers.participants = input.value);
      box.appendChild(input);
      grid.appendChild(box);
    }

    if (page.fields.includes("mainPersonName")){
      const box = makeInputBox("主役のお名前/英字表記", true, "例：十色 / toiro");
      const input = document.createElement("input"); input.type="text";
      input.value = state.answers.mainPersonName;
      input.addEventListener("input", ()=> state.answers.mainPersonName = input.value);
      box.appendChild(input);
      grid.appendChild(box);
    }

    pageRoot.appendChild(grid);
  }

// ③ 着付け
if (page.fields.includes("dressingNeed")) {
  pageRoot.appendChild(
    renderRadio(
      "dressingNeed",
      "着付けヘアセットご希望",
      true,
      ["着付けのみ", "着付けヘアセット", "無し"],
      ""
    )
  );

  // ✅ カレンダー（着付け無しの時だけ）
  function formatSlotLabel(slot){
  const [h, m] = String(slot).split(":").map(Number);
  const ampm = h < 12 ? "午前" : "午後";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${ampm}${hour12}:${String(m).padStart(2, "0")}`;
}
  
  if (state.answers.dressingNeed === "無し") {
    const dateBox = makeInputBox(
      "ご希望日",
      true,
      "カレンダーで空き状況を確認し、日付を選択してください"
    );
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = state.answers.preferredDate || "";
    dateInput.addEventListener("change", ()=>{
      clearError();
      state.answers.preferredDate = dateInput.value;
      state.answers.preferredTime = "";
      if (!dateInput.value) {
        state.availableSlots = [];
        state.slotsLoading = false;
        state.slotsDate = "";
        render();
        return;
      }
      fetchSlots(dateInput.value);
    });
    dateBox.appendChild(dateInput);
    pageRoot.appendChild(dateBox);

    const timeBox = makeInputBox(
      "ご希望時間帯",
      true,
      "日付を選ぶと、空き枠のみ選択できます（90分枠）"
    );
    const timeSelect = document.createElement("select");
    const dateSelected = !!String(state.answers.preferredDate || "").trim();
    const loading = state.slotsLoading && state.slotsDate === state.answers.preferredDate;
    const slots = Array.isArray(state.availableSlots) ? state.availableSlots : [];

    if (!dateSelected) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "先にご希望日を選択してください";
      timeSelect.appendChild(opt);
      timeSelect.disabled = true;
    } else if (loading) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "空き状況を確認中...";
      timeSelect.appendChild(opt);
      timeSelect.disabled = true;
    } else if (slots.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "この日は空きがありません。別の日をお選びください。";
      timeSelect.appendChild(opt);
      timeSelect.disabled = true;
    } else {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "時間帯を選択してください";
      timeSelect.appendChild(placeholder);

      slots.forEach((slot) => {
  const opt = document.createElement("option");
  opt.value = slot;
  opt.textContent = formatSlotLabel(slot);
  timeSelect.appendChild(opt);
});
      timeSelect.value = slots.includes(state.answers.preferredTime) ? state.answers.preferredTime : "";
      timeSelect.disabled = false;
    }

    timeSelect.addEventListener("change", ()=> state.answers.preferredTime = timeSelect.value);
    timeBox.appendChild(timeSelect);
    pageRoot.appendChild(timeBox);

    if (SHOW_EMBED_CALENDAR) {
    const calBox = makeInputBox(
  "空き状況確認用カレンダー（着付け無しの場合）",
  false,
  "空いている日時をご確認のうえ、上の入力欄にご希望日時をご記入ください。"
);

/*const calendarUrl =
  "https://calendar.google.com/calendar/embed?src=araragi0040%40gmail.com&ctz=Asia%2FTokyo";*/

const calendarUrl =
  "https://calendar.google.com/calendar/embed?src=araragi0040%40gmail.com&ctz=Asia%2FTokyo";

/* const calendarUrl =
  "https://calendar.app.google/nF24uBwBLgW8bn9F7"; */

// 縮小率（0.7〜0.9くらいで調整）
const previewScale = 0.78;

// 外枠
const previewWrap = document.createElement("div");
previewWrap.style.width = "100%";
previewWrap.style.height = "360px";
previewWrap.style.overflowY = "auto";    // ← 縦スクロール可能に
previewWrap.style.overflowX = "hidden";
previewWrap.style.border = "1px solid var(--line)";
previewWrap.style.borderRadius = "12px";
previewWrap.style.background = "#fff";
previewWrap.style.position = "relative";
previewWrap.style.marginTop = "8px";

// iframe
const iframe = document.createElement("iframe");
iframe.src = calendarUrl;
iframe.loading = "lazy";
iframe.style.border = "0";
iframe.style.display = "block";
iframe.style.transform = `scale(${previewScale})`;
iframe.style.transformOrigin = "top left";

// 縮小後に右や下が切れにくいように大きめにしておく
iframe.style.width = `${100 / previewScale}%`;
iframe.style.height = `${650 / previewScale}px`;

previewWrap.appendChild(iframe);
calBox.appendChild(previewWrap);

const link = document.createElement("div");
link.className = "h";
link.innerHTML =
  `表示がうまく出ない場合は <a href="${calendarUrl}" target="_blank" rel="noopener">こちら</a> からご確認ください。`;

calBox.appendChild(link);
pageRoot.appendChild(calBox);
}
}
}

  // 着付け詳細（無し以外）
  if (page.fields.includes("dressingDetail") && state.answers.dressingNeed && state.answers.dressingNeed !== "無し"){
    const box = makeInputBox("着付けされる希望者の詳細", true, "例：着付けヘア 母1名 訪問着 / 7歳女の子1名 など");
    const input = document.createElement("input"); input.type="text";
    input.value = state.answers.dressingDetail;
    input.addEventListener("input", ()=> state.answers.dressingDetail = input.value);
    box.appendChild(input);
    pageRoot.appendChild(box);

    pageRoot.appendChild(
      renderRadio("dressingPlace","着付け希望場所",true,["当写真館","ご自宅"],"")
    );

    if (state.answers.dressingPlace === "ご自宅"){
      const box2 = makeInputBox("着付け場所ご住所", true, "祖母様ご自宅などの場合は「その他」にご記入ください");
      const wrap = document.createElement("div"); wrap.className="choices";

      ["同上","その他"].forEach(opt=>{
        const label = document.createElement("label"); label.className="choice";
        const input = document.createElement("input"); input.type="radio"; input.name="dressingAddressChoice";
        input.value = opt; input.checked = (state.answers.dressingAddressChoice === opt);
        input.addEventListener("change", ()=>{
          state.answers.dressingAddressChoice = opt;
          if (opt !== "その他") state.answers.dressingAddressOther = "";
          rerenderAll();
        });
        const span = document.createElement("div"); span.textContent = opt;
        label.appendChild(input); label.appendChild(span);
        wrap.appendChild(label);
      });
      box2.appendChild(wrap);

      const other = document.createElement("input");
      other.type="text";
      other.placeholder="その他の住所（必要な場合）";
      other.value = state.answers.dressingAddressOther;
      const enabled = (state.answers.dressingAddressChoice === "その他");
      other.disabled = !enabled;
      other.style.opacity = enabled ? 1 : 0.6;
      other.addEventListener("input", ()=> state.answers.dressingAddressOther = other.value);
      box2.appendChild(other);
      pageRoot.appendChild(box2);

      pageRoot.appendChild(
        renderRadio("parkingSpace","駐車空きスペースの有無",true,["空きスペース有り","空きスペース無し"],"")
      );
    }
  }

  // 着物レンタル
  if (page.fields.includes("kimonoRental")) {
    const box = makeInputBox("着物レンタル(訪問着、産着等)ご希望", true, "");
    const wrap = document.createElement("div");
    wrap.className = "choices";

    const OPTIONS = [
      "お支度セットプラン（着物/小物一式レンタル/着付けヘアセット代含む）",
      "訪問着",
      "産着",
      "七五三着物",
      "無し",
      "その他"
    ];

    const cur = new Set(state.answers.kimonoRentalItems || []);

    function applyExclusiveRules(changedValue, checked){
      if (changedValue === "無し" && checked){
        cur.clear();
        cur.add("無し");
        state.answers.kimonoRentalOther = "";
        return;
      }
      if (changedValue !== "無し" && checked){
        cur.delete("無し");
      }
      if (changedValue === "その他" && !checked){
        state.answers.kimonoRentalOther = "";
      }
    }

    OPTIONS.forEach(labelText => {
      const label = document.createElement("label");
      label.className = "choice";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = cur.has(labelText);

      input.addEventListener("change", () => {
        const checked = input.checked;
        if (checked) cur.add(labelText);
        else cur.delete(labelText);

        applyExclusiveRules(labelText, checked);
        state.answers.kimonoRentalItems = Array.from(cur);
        rerenderAll();
      });

      const span = document.createElement("div");
      span.textContent = labelText;

      label.appendChild(input);
      label.appendChild(span);
      wrap.appendChild(label);
    });

    box.appendChild(wrap);

    const other = document.createElement("input");
    other.type = "text";
    other.placeholder = "その他の内容をご記入ください";
    const isOther = (state.answers.kimonoRentalItems || []).includes("その他");
    other.value = state.answers.kimonoRentalOther || "";
    other.disabled = !isOther;
    other.style.opacity = isOther ? 1 : 0.6;
    other.addEventListener("input", () => state.answers.kimonoRentalOther = other.value);
    box.appendChild(other);

    pageRoot.appendChild(box);
}
    
  // ④ プラン
  if (page.fields.includes("planType")){
    pageRoot.appendChild(
      renderRadio("planType","ご希望の撮影プラン",true,[
        "写真館撮影 35,000円~",
        "出張撮影 ※東大阪市のみ出張費無料",
        "セットプラン(写真館&出張撮影) 合計金額 -5,000円OFF🉐"
      ],"")
    );
  }

  if (page.fields.includes("planStudio") && String(state.answers.planType||"").startsWith("写真館撮影")){
    pageRoot.appendChild(renderRadio("planStudio","写真館撮影プラン（当日変更OK）",true, PLAN_STUDIO,""));
  }

  if (page.fields.includes("planOutcall") && String(state.answers.planType||"").startsWith("出張撮影")){
    pageRoot.appendChild(renderRadio("planOutcall","出張撮影プラン",true, PLAN_OUTCALL,""));
  }

  if (page.fields.includes("planSet") && String(state.answers.planType||"").startsWith("セットプラン")){
    const opts = ["▼写真館撮影", ...PLAN_STUDIO, "▼出張撮影", ...PLAN_OUTCALL];

    const box = makeInputBox("セットプラン選択（写真館＋出張）", true, "合計から5,000円OFFになります");
    const wrap = document.createElement("div"); wrap.className="choices";
    const cur = new Set(state.answers.planSet || []);

    opts.forEach(opt=>{
      const isHeader = opt.startsWith("▼");
      const label = document.createElement("label"); label.className="choice";
      if (isHeader){ label.style.opacity = 0.75; label.style.cursor="default"; }

      const input = document.createElement("input"); input.type="checkbox";
      input.disabled = isHeader;
      input.checked = cur.has(opt);

      input.addEventListener("change", ()=>{
        if (input.checked) cur.add(opt);
        else cur.delete(opt);

        // 見出し除外
        opts.filter(x=>x.startsWith("▼")).forEach(x=>cur.delete(x));

        state.answers.planSet = Array.from(cur);
        rerenderAll();
      });

      const span = document.createElement("div"); span.textContent = opt;
      label.appendChild(input); label.appendChild(span);
      wrap.appendChild(label);
    });

    box.appendChild(wrap);
    pageRoot.appendChild(box);
  }

  // options
  if (page.fields.includes("options")){
    pageRoot.appendChild(
      renderCheckbox("options","パネル/アルバム（任意）",false,[
        "① A4木製ガラスパネル (305×220mm) ¥20,000",
        "② 2面アルバム (216×216mm) ¥25,000",
        "③ 3面アルバム (216×216mm) ¥30,000",
        "④ アルバム10P M (216×216mm) ¥35,000",
        "⑤ アルバム10P L (305×305mm) ¥40,000",
        "⑥ クリスタルアルバム10P (301×299mm) ¥55,000"
      ],"ご予約時のご注文に限り → 表記価格より10%OFF")
    );
  }

  // ⑤ 仕上げ
  if (page.fields.includes("paymentMethod")){
    pageRoot.appendChild(renderRadio("paymentMethod","お支払い方法",true,["現金払い","お振り込み"],""));
  }

  if (page.fields.includes("howKnew")){
    const box = makeInputBox("当店を何で知りましたか？", true, "ご紹介の場合はその他にご記入ください");
    const wrap = document.createElement("div"); wrap.className="choices";

    ["ホームページ","Instagram","Googleマップ","リピーター","その他"].forEach(opt=>{
      const label = document.createElement("label"); label.className="choice";
      const input = document.createElement("input"); input.type="radio"; input.name="howKnew";
      input.value = opt; input.checked = (state.answers.howKnew === opt);
      input.addEventListener("change", ()=>{
        state.answers.howKnew = opt;
        if (opt !== "その他") state.answers.howKnewOther = "";
        rerenderAll();
      });
      const span = document.createElement("div"); span.textContent = opt;
      label.appendChild(input); label.appendChild(span);
      wrap.appendChild(label);
    });

    box.appendChild(wrap);

    const other = document.createElement("input");
    other.type="text";
    other.placeholder="その他（ご紹介者名など）";
    other.value = state.answers.howKnewOther;
    const enabled = (state.answers.howKnew === "その他");
    other.disabled = !enabled;
    other.style.opacity = enabled ? 1 : 0.6;
    other.addEventListener("input", ()=> state.answers.howKnewOther = other.value);
    box.appendChild(other);

    pageRoot.appendChild(box);
  }

  if (page.fields.includes("message")){
    const box = makeInputBox("備考（任意）", false, "");
    const ta = document.createElement("textarea");
    ta.value = state.answers.message;
    ta.addEventListener("input", ()=> state.answers.message = ta.value);
    box.appendChild(ta);
    pageRoot.appendChild(box);
  }

  if (page.fields.includes("agreements")){
    const box = document.createElement("div");
    box.className = "q";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = "同意（送信に必要です）";
    const r = document.createElement("span"); r.className="req"; r.textContent="必須";
    t.appendChild(r);
    box.appendChild(t);

    const details1 = document.createElement("details");
    const sum1 = document.createElement("summary");
    sum1.textContent = "個人情報の取扱い（タップで表示）";
    const body1 = document.createElement("div");
    body1.className = "terms";
    body1.textContent =
`・ご入力いただいた情報は、ご予約対応・連絡・サービス提供の目的で利用します。
・第三者へ提供しません（法令に基づく場合を除きます）。
・必要に応じて、確認のためご連絡する場合があります。`;
    details1.appendChild(sum1); details1.appendChild(body1);

    const details2 = document.createElement("details");
    const sum2 = document.createElement("summary");
    sum2.textContent = "キャンセル規定（タップで表示）";
    const body2 = document.createElement("div");
    body2.className = "terms";
    body2.textContent =
`・日程変更/キャンセルは、出来るだけ早めにご連絡下さい。
・天候や体調不良など、事情ある場合は柔軟に対応させていただきます。
・お客様の都合で撮影をキャンセルする場合は以下のキャンセル料が発生します。
撮影当日〜3日前　撮影料金の全額
撮影日の4〜7日前　撮影料金の50%
撮影日の8〜14日前　撮影料金の30%`;
    details2.appendChild(sum2); details2.appendChild(body2);

    box.appendChild(details1);
    box.appendChild(details2);

    function addAgree(key, labelText){
      const c = document.createElement("label"); c.className="choice";
      const i = document.createElement("input"); i.type="checkbox"; i.checked = !!state.answers[key];
      i.addEventListener("change", ()=> state.answers[key] = i.checked);
      const s = document.createElement("div"); s.textContent = labelText;
      c.appendChild(i); c.appendChild(s);
      box.appendChild(c);
    }

    addAgree("privacyAgree", "個人情報の取扱いに同意します");
    addAgree("cancelAgree", "キャンセル規定に同意します");

    pageRoot.appendChild(box);
  }

if (page.fields.includes("review")){
  // 外枠（内容確認）
  const outerBox = makeInputBox("内容確認（送信前）", false, "");

  // 説明文
  const lead = document.createElement("div");
  lead.className = "h";
  lead.style.marginTop = "6px";
  lead.innerHTML = `
    ご予約フォームのご入力ありがとうございます。<br>
    下記がご入力内容ですので、ご確認ください。<br>
    確認後、改めて公式LINEよりご連絡いたします。
  `;
  outerBox.appendChild(lead);

  const innerBox = document.createElement("div");
  innerBox.className = "confirmInnerBox";

  const rv = document.createElement("div");
  rv.className = "review";
  rv.innerHTML = buildReviewHTML();

  innerBox.appendChild(rv);
  outerBox.appendChild(innerBox);

  // 店名（外枠内）
  const brand = document.createElement("div");
  brand.className = "confirmBrand";
  brand.textContent = "写真館toiro";
  outerBox.appendChild(brand);

  pageRoot.appendChild(outerBox);
}
}

// レビューHTML
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

function buildReviewHTML(){
  const a = state.answers;

  const items = [];

  // 連絡先
  items.push(rowL1("お名前", a.name));
  items.push(rowL1("メール", a.email));
  items.push(rowL1("電話", formatPhone(a.phone)));

  // 撮影内容
  {
    const contents = Array.isArray(a.shootingContents) ? a.shootingContents : [];
    const display = contents.map(x => x === "その他" ? `その他（${a.shootingContentsOther || ""}）` : x);
    items.push(rowL1("撮影内容", display.join("、"),"mobile-break"));
  }

  // 着付け
  {
    items.push(rowL1("着付けヘアセットご希望", a.dressingNeed || "無し", "mobile-break"));

    if (a.dressingNeed && a.dressingNeed !== "無し") {
      const detailText = String(a.dressingDetail || "").trim();
      if (detailText) {
        items.push(rowL2(detailText, "kimono"));
      }
    }
  }

  // 着物レンタル（★このブロックが画像の1つ目の対象）
  {
    const r = Array.isArray(a.kimonoRentalItems) ? a.kimonoRentalItems : [];
    if (r.length){
      if (r.includes("無し")){
        items.push(rowL1("着物レンタル", "無し"));
      } else {
        items.push(rowL1("着物レンタル", "有り","mobile-break"));
        const detail = r.map(x => x === "その他" ? `その他（${a.kimonoRentalOther || ""}）` : x);
        items.push(rowL2(detail.join("、"), "kimono")); // ← 子を L2 で固定インデント
      }
    }
  }

  // プラン（★画像の2つ目の対象）
  const isSet = String(a.planType || "").startsWith("セットプラン");
  if (!isSet){
    if (String(a.planType || "").startsWith("写真館撮影") && a.planStudio){
      items.push(rowL1("プラン", "写真館撮影","mobile-break"));
      items.push(rowL2(a.planStudio, "plan"));
    } else if (String(a.planType || "").startsWith("出張撮影") && a.planOutcall){
      items.push(rowL1("プラン", "出張撮影","mobile-break"));
      items.push(rowL2(a.planOutcall, "plan"));
    } else {
      items.push(rowL1("プラン", a.planType || "","mobile-break"));
    }
  } else {
    items.push(rowL1("プラン", a.planType || "","mobile-break"));

    const cleaned = (Array.isArray(a.planSet) ? a.planSet : [])
      .filter(x => x && !String(x).startsWith("▼"));

    const studioItems = cleaned.filter(x => PLAN_STUDIO.includes(x));
    const outcallItems = cleaned.filter(x => PLAN_OUTCALL.includes(x));

    if (studioItems.length){
      items.push(rowL2("写真館撮影", "plan"));
studioItems.forEach(x => items.push(rowL3(x, "plan")));
      }
    if (outcallItems.length){
      items.push(rowL2("出張撮影", "plan"));
outcallItems.forEach(x => items.push(rowL3(x, "plan")));
    }
  }

// パネル/アルバム（┗を一切出さない）
if (Array.isArray(a.options) && a.options.length){
  items.push(rowL1("パネル/アルバム", "","mobile-break"));
  a.options.forEach(x => items.push(rowL2NoMark(x, "panel"))); // ★全部┗なし
}

  return `<div class="reviewList">${items.join("")}</div>`;
}

// レベル別行
function rowL1(label, value, extraClass = ""){
  return `
    <div class="rv rv-l1 ${extraClass}">
      <div class="rv-mark">■</div>
      <div class="rv-body rv-body-l1">
        <div class="rv-label">${esc(label)}：</div>
        ${value ? `<div class="rv-value rv-value-l1">${esc(value)}</div>` : ""}
      </div>
    </div>
  `;
}
function rowL2(text, group = ""){
  const grp = group ? ` grp-${group}` : "";
  return `
    <div class="rv rv-l2${grp}">
      <div class="rv-mark">┗</div>
      <div class="rv-body">
        <div class="rv-value">${esc(text)}</div>
      </div>
    </div>
  `;
}
function rowL2NoMark(text, group){
  const g = group ? ` grp-${group}` : "";
  return `
    <div class="rv rv-l2 rv-l2-nomark${g}">
      <div class="rv-mark"></div>
      <div class="rv-body">
        <div class="rv-value">${esc(text)}</div>
      </div>
    </div>
  `;
}
function rowL3(text, group = ""){
  const grp = group ? ` grp-${group}` : "";
  return `
    <div class="rv rv-l3${grp}">
      <div class="rv-mark">・</div>
      <div class="rv-body">
        <div class="rv-value">${esc(text)}</div>
      </div>
    </div>
  `;
}

// ====== バリデーション ======
function isEmailValid(v){
  const s = String(v||"").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validatePage(){
  const a = state.answers;
  const p = pages[state.pageIndex];

  if (p.fields.includes("email")){
    if (!String(a.email||"").trim()) return "メールアドレスは必須です。";
    if (!isEmailValid(a.email)) return "メールアドレスの形が違うかもです（例：aaa@bbb.com）";
  }
  if (p.fields.includes("name") && !String(a.name||"").trim()) return "お名前は必須です。";
  if (p.fields.includes("postal")){
    const postal = String(a.postal || "").trim();
    if (!postal) return "郵便番号は必須です。";
    if (!/^\d{3}-?\d{4}$/.test(postal)) return "郵便番号の形式が違います（例：123-4567）。";
  }
  if (p.fields.includes("address") && !String(a.address||"").trim()) return "ご住所は必須です。";
  if (p.fields.includes("phone")){
    if (!String(a.phone||"").trim()) return "お電話番号は必須です。";
    a.phone = formatPhone(a.phone);
    if (!/^\d{9,15}$/.test(a.phone)) return "お電話番号は9〜15桁の数字で入力してください。";
  }

  if (p.fields.includes("shootingContents")){
    if (!Array.isArray(a.shootingContents) || a.shootingContents.length === 0) return "撮影内容は必須です。";
    if (a.shootingContents.includes("その他") && !String(a.shootingContentsOther||"").trim())
      return "撮影内容で「その他」を選んだ場合は内容を入力してください。";
  }

  if (p.fields.includes("shootingPlace") && !String(a.shootingPlace||"").trim()) return "撮影場所は必須です。";
  if (p.fields.includes("participants") && !String(a.participants||"").trim()) return "ご参加人数は必須です。";
  if (p.fields.includes("mainPersonName") && !String(a.mainPersonName||"").trim()) return "主役のお名前/英字表記は必須です。";

  if (p.fields.includes("dressingNeed") && !String(a.dressingNeed||"").trim()) return "着付け希望は必須です。";
  if (p.fields.includes("dressingNeed") && a.dressingNeed === "無し"){
    if (!String(a.preferredDate||"").trim()) return "着付け無しの場合はご希望日を入力してください。";
    if (!String(a.preferredTime||"").trim()) return "着付け無しの場合はご希望時間帯を選択してください。";
    if (state.slotsLoading && state.slotsDate === a.preferredDate) return "空き状況の確認完了後にご希望時間帯を選択してください。";
    if (state.slotsDate !== a.preferredDate) return "ご希望日の空き枠を確認してから時間帯を選択してください。";
    if (!Array.isArray(state.availableSlots) || !state.availableSlots.includes(a.preferredTime)) {
      return "ご希望時間帯は表示された空き枠から選択してください。";
    }
  }
  if (p.fields.includes("dressingDetail") && a.dressingNeed && a.dressingNeed !== "無し"){
    if (!String(a.dressingDetail||"").trim()) return "着付け詳細は必須です。";
    if (!String(a.dressingPlace||"").trim()) return "着付け希望場所は必須です。";
    if (a.dressingPlace === "ご自宅"){
      if (!String(a.dressingAddressChoice||"").trim()) return "着付け住所（同上/その他）は必須です。";
      if (a.dressingAddressChoice === "その他" && !String(a.dressingAddressOther||"").trim())
        return "着付け住所の「その他」を入力してください。";
      if (!String(a.parkingSpace||"").trim()) return "駐車スペースは必須です。";
    }
  }

  if (p.fields.includes("kimonoRental")){
    const items = a.kimonoRentalItems || [];
    if (!Array.isArray(items) || items.length === 0) return "着物レンタル希望は必須です。";
    if (items.includes("その他") && !String(a.kimonoRentalOther||"").trim())
      return "レンタルで「その他」を選んだ場合は内容を入力してください。";
  }

  if (p.fields.includes("planType") && !String(a.planType||"").trim()) return "撮影プランは必須です。";
  if (p.fields.includes("planStudio") && String(a.planType||"").startsWith("写真館撮影")){
    if (!String(a.planStudio||"").trim()) return "写真館プランを選択してください。";
  }
  if (p.fields.includes("planOutcall") && String(a.planType||"").startsWith("出張撮影")){
    if (!String(a.planOutcall||"").trim()) return "出張プランを選択してください。";
  }
  if (p.fields.includes("planSet") && String(a.planType||"").startsWith("セットプラン")){
    const selected = Array.isArray(a.planSet) ? a.planSet : [];
    const hasStudio = selected.some(x => PLAN_STUDIO.includes(x));
    const hasOutcall = selected.some(x => PLAN_OUTCALL.includes(x));
    if (!hasStudio && !hasOutcall) return "セットプランでは、写真館撮影プランと出張撮影プランをそれぞれ1つ以上選択してください。";
    if (!hasStudio) return "セットプランでは、写真館撮影プランを1つ以上選択してください。";
    if (!hasOutcall) return "セットプランでは、出張撮影プランを1つ以上選択してください。";
  }

  if (p.fields.includes("paymentMethod") && !String(a.paymentMethod||"").trim()) return "お支払い方法は必須です。";
  if (p.fields.includes("howKnew")){
    if (!String(a.howKnew||"").trim()) return "何で知りましたか？は必須です。";
    if (a.howKnew === "その他" && !String(a.howKnewOther||"").trim()) return "「その他」を選んだ場合は内容を入力してください。";
  }

  if (p.fields.includes("agreements")){
    if (!a.privacyAgree || !a.cancelAgree) {
      return "個人情報・キャンセル規定への同意が必要です。";
    }
  }

  return null;
}

// ====== ボタン ======
btnBack.addEventListener("click", ()=>{
  clearError();
  state.pageIndex--;
  render();
  scrollToTopAfterRender();
});

btnNext.addEventListener("click", ()=>{
  clearError();

  const msg = validatePage();
  if (msg) return showError(msg);

  const last = state.pageIndex === pages.length - 1;

  // 最終ページならそのまま送信
  if (last){
    submitAll();
    return;
  }

  // 通常は次へ
  state.pageIndex++;
  render();
  scrollToTopAfterRender();
});

async function submitAll(){
  const minMs = (state.server.minSubmitSeconds || 3) * 1000;
  if (Date.now() - openedAtMs < minMs) {
    showError(`送信が早すぎます。${state.server.minSubmitSeconds}秒ほど待ってから送信してください。`);
    return;
  }

  if (!state.formToken) {
    showError("初期化に失敗しました。ページを更新してから再度お試しください。");
    return;
  }

  // 全ページチェック
  for (let i=0;i<pages.length;i++){
    const prev = state.pageIndex;
    state.pageIndex = i;
    cleanupByBranch();
    const msg = validatePage();
    if (msg){
      state.pageIndex = i;
      render();
      showError(msg);
      return;
    }
    state.pageIndex = prev;
  }

  cleanupByBranch();

  const sendAnswers = (typeof structuredClone === "function")
    ? structuredClone(state.answers)
    : JSON.parse(JSON.stringify(state.answers));

  ensureHoneypotInput();
  const hpEl = document.querySelector('input[name="website"][data-honeypot="1"]');
  const payload = {
    formToken: state.formToken || "",
    website: hpEl ? hpEl.value : "",
    answers: sendAnswers
  };

  const prevNextDisabled = btnNext.disabled;
  const prevBackDisabled = btnBack.disabled;
  btnNext.disabled = true;
  btnBack.disabled = true;
  toggleLoading(true);

  try {
    const res = await fetch(`${API_BASE}?action=submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("サーバー応答の解析に失敗しました。時間をおいて再度お試しください。");
    }
    if (!json.ok) throw new Error(json.message || "送信に失敗しました");

    pageCard.style.display = "none";
    doneCard.style.display = "block";
    doneId.textContent = json.submissionId ? `送信ID：${json.submissionId}` : "";
    window.scrollTo({ top: 0, behavior: "smooth" });

  } catch (e) {
    showError(`送信に失敗しました。\n${e && e.message ? e.message : e}`);
  } finally {
    toggleLoading(false);
    btnNext.disabled = prevNextDisabled;
    btnBack.disabled = prevBackDisabled;
  }
}
