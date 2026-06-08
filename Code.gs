/*******************************************************
 * Reservation Form API (GAS)
 * - GET  /exec?action=config   : 設定取得
 * - POST /exec                : 送信（payload JSON）
 *******************************************************/

// ====== 設定 ======
const CONFIG = {
  SPREADSHEET_ID: "19ebajuqC4fYYVofkrPMXE2OSKVir76dOGYdsPoQA20w",
  SHEET_NAME: "フォーム",
  /*ADMIN_EMAIL: "fujii@g-knowthyself.com,photoworks.toiro@gmail.com",*/
  ADMIN_EMAIL: "fujii@g-knowthyself.com",
  TERMS_VERSION: "2025-12-18",
  MIN_SUBMIT_SECONDS: 3,
  CALENDAR_ID: "araragi0040@gmail.com",
  SLOT_LABELS: ["10:00", "11:30", "13:00", "14:30", "16:00"],
  SLOT_DURATION_MIN: 90,

  CUSTOMER_SUBJECT: "【ご予約受付】内容を受け付けました",
  CUSTOMER_BODY_HEADER:
`この度はご予約ありがとうございます。
内容を受け付けました。

下記の内容で承っておりますので、ご確認ください。
（内容確認のうえ、担当よりご連絡いたします）

`,
  CUSTOMER_BODY_FOOTER:
`
※このメールは自動送信です。返信いただいても確認できない場合があります。
ご連絡は公式LINEまたはSNSのDM等からお願いいたします。

――――――――――
写真館toiro
`
};

// ====== JSONレスポンス ======
function json_(obj){
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== フロント初期化用（★これが無いと今回のエラーになります） ======
function getServerConfig(){
  return {
    adminEmailMasked: maskEmail_(CONFIG.ADMIN_EMAIL),
    sheetName: CONFIG.SHEET_NAME,
    termsVersion: CONFIG.TERMS_VERSION,
    minSubmitSeconds: CONFIG.MIN_SUBMIT_SECONDS
  };
}

// ====== GET: configなど ======
function doGet(e){
  const action = String((e && e.parameter && e.parameter.action) || "");

  if (action === "config") {
    const token = Utilities.getUuid();
    CacheService.getScriptCache().put(
      `ft_${token}`,
      String(Date.now()),
      21600 // max 6 hours
    );

    const cfg = getServerConfig();
    cfg.formToken = token;
    return json_({ ok:true, data: cfg });
  }

  if (action === "slots") {
    try {
      const dateStr = String((e && e.parameter && e.parameter.date) || "").trim();
      const slots = getAvailableSlots_(dateStr);
      return json_({ ok: true, slots });
    } catch (err) {
      return json_({ ok: false, message: err && err.message ? err.message : String(err) });
    }
  }

  return json_({ ok:false, message:"unknown action" });
}

// ====== POST: 送信 ======
function doPost(e){
  try {
    const body = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    const payload = body ? JSON.parse(body) : null;

    const res = submitReservation(payload); // 下に実装
    return json_({ ok:true, submissionId: res.submissionId });

  } catch(err){
    return json_({ ok:false, message: err && err.message ? err.message : String(err) });
  }
}

// ====== 送信処理（元のロジック） ======
function submitReservation(payload) {
  if (!payload || !payload.answers) throw new Error("送信データが空です");

  if (String(payload.website || "").trim()) {
    throw new Error("不正なリクエストです。");
  }

  const token = String(payload.formToken || "").trim();
  if (!token) {
    throw new Error("トークンが無効です。ページを再読み込みしてください。");
  }

  const a = payload.answers;

  // token + server-side timing check (do not consume token on failure)
  {
    const cache = CacheService.getScriptCache();
    const issuedStr = cache.get(`ft_${token}`);
    if (!issuedStr) {
      throw new Error("トークンが無効です。ページを再読み込みしてください。");
    }
    const elapsedMs = Date.now() - Number(issuedStr);
    const minMs = CONFIG.MIN_SUBMIT_SECONDS * 1000;
    if (!(elapsedMs >= minMs)) {
      throw new Error("送信が早すぎます。少し待ってからもう一度送ってください。");
    }
  }

  validateAnswers_(a);

  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);

  try {
    // token check again under lock (prevents reuse / race)
    const cache = CacheService.getScriptCache();
    const issuedStr = cache.get(`ft_${token}`);
    if (!issuedStr) {
      throw new Error("トークンが無効です。ページを再読み込みしてください。");
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME);

    const headers = buildHeaders_();
    ensureHeaderRow_(sheet, headers);

    const submissionId = generateSubmissionId_(sheet);

    if (a.dressingNeed === "無し") {
      if (!isSlotCurrentlyAvailable_(a.preferredDate, a.preferredTime)) {
        throw new Error("選択した時間帯はすでに埋まっています。日付を選び直して空き枠を再選択してください。");
      }

      const slot = getSlotWindow_(a.preferredDate, a.preferredTime);
      const title = String(a.name || "").trim() || "予約";
      const description = [
      `メールアドレス：${String(a.email || "").trim()}`,
      `電話番号：${String(a.phone || "").trim()}`,
      `撮影場所：${String(a.shootingPlace || "").trim()}`
      ]
      .filter(line => !line.endsWith("："))
      .join("\n");

      getCalendar_().createEvent(title, slot.start, slot.end, {
      description: description
      });
      }

    const rowObj = buildRowObject_(a, submissionId);
    const map = buildHeaderKeyMap_();
    const row = headers.map(h => {
      const key = map[h];
      const v = key ? (rowObj[key] ?? "") : "";
      if (typeof v === "boolean") return v ? "同意" : "未同意";
      return sanitizeForSheet_(v);
    });
    sheet.appendRow(row);

    // consume token only after accepting the submission
    cache.remove(`ft_${token}`);

    // 管理者メール
    const adminBody = buildAdminMailBody_(a, submissionId);
    try {
      MailApp.sendEmail({
        to: CONFIG.ADMIN_EMAIL,
        subject: `【新規予約】${a.name || "お客様"} / ID:${submissionId.slice(0, 8)}`,
        body: adminBody,
        htmlBody: toHtmlBody_(adminBody)
      });
    } catch (e) {
      Logger.log(`admin mail failed: ${e && e.message ? e.message : e}`);
    }

    // お客様メール
    const customerEmail = String(a.email || "").trim();
    if (customerEmail) {
      const customerBody = buildCustomerMailBody_(a, submissionId);
      try {
        MailApp.sendEmail({
          to: customerEmail,
          subject: CONFIG.CUSTOMER_SUBJECT,
          body: customerBody,
          htmlBody: toHtmlBody_(customerBody),
          replyTo: CONFIG.ADMIN_EMAIL
        });
      } catch (e) {
        Logger.log(`customer mail failed: ${e && e.message ? e.message : e}`);
      }
    }

    return { ok:true, submissionId };

  } finally {
    lock.releaseLock();
  }
}

function sanitizeForSheet_(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const trimmed = s.replace(/^\s+/, "");
  if (/^[=+\-@]/.test(trimmed)) return `'${s}`;
  return s;
}

function validateAnswers_(a) {
  if (!a || typeof a !== "object") throw new Error("送信データが不正です。");

  const trim = (v) => String(v ?? "").trim();
  const normalizePhone = (v) => String(v ?? "").replace(/\D/g, "");

  const email = trim(a.email);
  if (!email) throw new Error("メールアドレスは必須です。");
  if (email.length > 254) throw new Error("メールアドレスが長すぎます。");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("メールアドレスが不正です。");
  a.email = email;

  const name = trim(a.name);
  if (!name) throw new Error("お名前は必須です。");
  if (name.length > 200) throw new Error("お名前が長すぎます。");
  a.name = name;

  const postal = trim(a.postal);
  if (!postal) throw new Error("郵便番号は必須です。");
  if (postal.length > 32) throw new Error("郵便番号が長すぎます。");
  if (!/^\d{3}-?\d{4}$/.test(postal)) throw new Error("郵便番号が不正です。");
  a.postal = postal;

  const address = trim(a.address);
  if (!address) throw new Error("ご住所は必須です。");
  if (address.length > 500) throw new Error("ご住所が長すぎます。");
  a.address = address;

  const phone = normalizePhone(a.phone);
  if (!phone) throw new Error("お電話番号は必須です。");
  if (!/^\d{9,15}$/.test(phone)) throw new Error("お電話番号が不正です。");
  a.phone = phone;

  const contents = a.shootingContents;
  if (!Array.isArray(contents) || contents.length === 0) throw new Error("撮影内容は必須です。");
  if (contents.length > 20) throw new Error("撮影内容の選択数が多すぎます。");
  contents.forEach((x) => {
    const s = trim(x);
    if (!s) throw new Error("撮影内容が不正です。");
    if (s.length > 200) throw new Error("撮影内容が長すぎます。");
  });

  if (contents.includes("その他")) {
    const other = trim(a.shootingContentsOther);
    if (!other) throw new Error("撮影内容で「その他」を選んだ場合は内容を入力してください。");
    if (other.length > 500) throw new Error("撮影内容（その他）が長すぎます。");
    a.shootingContentsOther = other;
  } else {
    a.shootingContentsOther = "";
  }

  const shootingPlace = trim(a.shootingPlace);
  if (!shootingPlace) throw new Error("撮影場所は必須です。");
  if (shootingPlace.length > 500) throw new Error("撮影場所が長すぎます。");
  a.shootingPlace = shootingPlace;

  const participants = trim(a.participants);
  if (!participants) throw new Error("ご参加人数は必須です。");
  if (participants.length > 500) throw new Error("ご参加人数が長すぎます。");
  a.participants = participants;

  const mainPersonName = trim(a.mainPersonName);
  if (!mainPersonName) throw new Error("主役のお名前/英字表記は必須です。");
  if (mainPersonName.length > 200) throw new Error("主役のお名前が長すぎます。");
  a.mainPersonName = mainPersonName;

  const dressingNeed = trim(a.dressingNeed);
  if (!dressingNeed) throw new Error("着付け希望は必須です。");
  if (!["着付けのみ", "着付けヘアセット", "無し"].includes(dressingNeed)) {
    throw new Error("着付け希望が不正です。");
  }
  a.dressingNeed = dressingNeed;

  if (dressingNeed !== "無し") {
    a.preferredDate = "";
    a.preferredTime = "";

    const dressingDetail = trim(a.dressingDetail);
    if (!dressingDetail) throw new Error("着付け詳細は必須です。");
    if (dressingDetail.length > 500) throw new Error("着付け詳細が長すぎます。");
    a.dressingDetail = dressingDetail;

    const dressingPlace = trim(a.dressingPlace);
    if (!dressingPlace) throw new Error("着付け希望場所は必須です。");
    if (!["当写真館", "ご自宅"].includes(dressingPlace)) {
      throw new Error("着付け希望場所が不正です。");
    }
    a.dressingPlace = dressingPlace;

    if (dressingPlace === "ご自宅") {
      const choice = trim(a.dressingAddressChoice);
      if (!choice) throw new Error("着付け住所（同上/その他）は必須です。");
      if (!["同上", "その他"].includes(choice)) {
        throw new Error("着付け住所の選択が不正です。");
      }
      a.dressingAddressChoice = choice;

      if (choice === "その他") {
        const otherAddr = trim(a.dressingAddressOther);
        if (!otherAddr) throw new Error("着付け住所の「その他」を入力してください。");
        if (otherAddr.length > 500) throw new Error("着付け住所（その他）が長すぎます。");
        a.dressingAddressOther = otherAddr;
      } else {
        a.dressingAddressOther = "";
      }

      const parking = trim(a.parkingSpace);
      if (!parking) throw new Error("駐車スペースは必須です。");
      if (!["空きスペース有り", "空きスペース無し"].includes(parking)) {
        throw new Error("駐車スペースが不正です。");
      }
      a.parkingSpace = parking;
    } else {
      a.dressingAddressChoice = "";
      a.dressingAddressOther = "";
      a.parkingSpace = "";
    }

  } else {
    const preferredDate = trim(a.preferredDate);
    if (!preferredDate) throw new Error("着付け無しの場合はご希望日を入力してください。");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) throw new Error("ご希望日の形式が不正です。");
    a.preferredDate = preferredDate;

    const preferredTime = trim(a.preferredTime);
    if (!preferredTime) throw new Error("着付け無しの場合はご希望時間帯を選択してください。");
    if (!getAllowedSlotLabels_().includes(preferredTime)) {
      throw new Error("ご希望時間帯が不正です。");
    }
    a.preferredTime = preferredTime;

    a.dressingDetail = "";
    a.dressingPlace = "";
    a.dressingAddressChoice = "";
    a.dressingAddressOther = "";
    a.parkingSpace = "";
  }

  const kimonoRentalItems = a.kimonoRentalItems;
  if (!Array.isArray(kimonoRentalItems) || kimonoRentalItems.length === 0) {
    throw new Error("着物レンタル希望は必須です。");
  }
  if (kimonoRentalItems.length > 20) throw new Error("着物レンタルの選択数が多すぎます。");
  kimonoRentalItems.forEach((x) => {
    const s = trim(x);
    if (!s) throw new Error("着物レンタル希望が不正です。");
    if (s.length > 200) throw new Error("着物レンタル希望が長すぎます。");
  });
  if (kimonoRentalItems.includes("無し") && !(kimonoRentalItems.length === 1 && kimonoRentalItems[0] === "無し")) {
    throw new Error("着物レンタルの選択が不正です。");
  }
  if (kimonoRentalItems.includes("その他")) {
    const other = trim(a.kimonoRentalOther);
    if (!other) throw new Error("レンタルで「その他」を選んだ場合は内容を入力してください。");
    if (other.length > 500) throw new Error("着物レンタル（その他）が長すぎます。");
    a.kimonoRentalOther = other;
  } else {
    a.kimonoRentalOther = "";
  }

  const planType = trim(a.planType);
  if (!planType) throw new Error("撮影プランは必須です。");
  a.planType = planType;

  if (planType.startsWith("写真館撮影")) {
    const planStudio = trim(a.planStudio);
    if (!planStudio) throw new Error("写真館プランを選択してください。");
    if (planStudio.length > 300) throw new Error("写真館プランが長すぎます。");
    a.planStudio = planStudio;
    a.planOutcall = "";
    a.planSet = [];

  } else if (planType.startsWith("出張撮影")) {
    const planOutcall = trim(a.planOutcall);
    if (!planOutcall) throw new Error("出張プランを選択してください。");
    if (planOutcall.length > 300) throw new Error("出張プランが長すぎます。");
    a.planOutcall = planOutcall;
    a.planStudio = "";
    a.planSet = [];

  } else if (planType.startsWith("セットプラン")) {
    const setRaw = Array.isArray(a.planSet) ? a.planSet : [];
    const cleaned = setRaw
      .map(x => trim(x))
      .filter(x => x && !x.startsWith("▼"));

    if (cleaned.length === 0) throw new Error("セットプランの中身（写真館＋出張）を選択してください。");
    if (cleaned.length > 20) throw new Error("セットプランの選択数が多すぎます。");
    cleaned.forEach((x) => {
      if (x.length > 300) throw new Error("セットプランの内容が長すぎます。");
    });
    const hasStudio = cleaned.some(x => PLAN_STUDIO_.includes(x));
    const hasOutcall = cleaned.some(x => PLAN_OUTCALL_.includes(x));
    if (!hasStudio && !hasOutcall) {
      throw new Error("セットプランでは、写真館撮影プランと出張撮影プランをそれぞれ1つ以上選択してください。");
    }
    if (!hasStudio) {
      throw new Error("セットプランでは、写真館撮影プランを1つ以上選択してください。");
    }
    if (!hasOutcall) {
      throw new Error("セットプランでは、出張撮影プランを1つ以上選択してください。");
    }

    a.planSet = cleaned;
    a.planStudio = "";
    a.planOutcall = "";

  } else {
    throw new Error("撮影プランが不正です。");
  }

  if (Array.isArray(a.options)) {
    if (a.options.length > 50) throw new Error("オプションの選択数が多すぎます。");
    a.options = a.options.map(x => trim(x)).filter(x => x);
  } else {
    a.options = [];
  }

  const paymentMethod = trim(a.paymentMethod);
  if (!paymentMethod) throw new Error("お支払い方法は必須です。");
  if (!["現金払い", "お振り込み"].includes(paymentMethod)) throw new Error("お支払い方法が不正です。");
  a.paymentMethod = paymentMethod;

  const howKnew = trim(a.howKnew);
  if (!howKnew) throw new Error("何で知りましたか？は必須です。");
  if (!["ホームページ", "Instagram", "Googleマップ", "リピーター", "その他"].includes(howKnew)) {
    throw new Error("何で知りましたか？が不正です。");
  }
  a.howKnew = howKnew;

  if (howKnew === "その他") {
    const howKnewOther = trim(a.howKnewOther);
    if (!howKnewOther) throw new Error("「その他」を選んだ場合は内容を入力してください。");
    if (howKnewOther.length > 500) throw new Error("当店を何で知りましたか？（その他）が長すぎます。");
    a.howKnewOther = howKnewOther;
  } else {
    a.howKnewOther = "";
  }

  const message = trim(a.message);
  if (message.length > 2000) throw new Error("備考が長すぎます。");
  a.message = message;

  if (!a.privacyAgree || !a.cancelAgree) {
    throw new Error("個人情報・キャンセル規定への同意が必要です。");
  }
}

function buildHeaderKeyMap_(){
  return {
    "送信日時": "timestamp",
    "受付ID": "submission_id",

    "メールアドレス": "email",
    "お名前": "name",
    "郵便番号": "postal",
    "ご住所": "address",
    "電話番号": "phone",

    "撮影内容": "shooting_contents",
    "撮影内容（その他）": "shooting_contents_other",

    "撮影場所": "shooting_place",
    "ご参加人数": "participants",
    "主役のお名前": "main_person_name",

    "着付けヘアセットご希望": "dressing_need",
    "着付け詳細": "dressing_detail",
    "着付け場所": "dressing_place",
    "着付け場所（同上/その他）": "dressing_address_choice",
    "着付け住所（その他）": "dressing_address_other",
    "駐車スペース有無": "parking_space",
    "希望日": "preferred_date",
    "希望時間帯": "preferred_time",

    "着物レンタル": "kimono_rental",
    "着物レンタル（その他）": "kimono_rental_other",

    "プラン種別": "plan_type",
    "写真館撮影プラン": "plan_studio",
    "出張撮影プラン": "plan_outcall",
    "セットプラン内容": "plan_set",

    "オプション": "options",
    "お支払い方法": "payment_method",
    "当店を何で知りましたか？": "how_knew",
    "当店を何で知りましたか？（その他）": "how_knew_other",
    "備考": "message",

    "プライバシー同意": "privacy_agree",
    "キャンセル規約同意": "cancel_agree",
    "同意日時": "agree_timestamp",
  };
}

// ====== 以下、元の内部関数 ======
function generateSubmissionId_(sheet){
  const now = new Date();
  const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd");

  const lastRow = sheet.getLastRow();
  const idCol = 2; // B列 = 受付ID

  const values = lastRow > 1
    ? sheet.getRange(2, idCol, lastRow - 1, 1).getValues()
    : [];

  const todayIds = values
    .flat()
    .filter(v => String(v).startsWith(dateStr + "-"));

  let nextNum = 1;
  if (todayIds.length > 0) {
    const nums = todayIds.map(id => Number(String(id).split("-")[1]) || 0);
    nextNum = Math.max(...nums) + 1;
  }

  return `${dateStr}-${nextNum}`;
}

function buildHeaders_() {
    return [
    "送信日時","受付ID",
    "メールアドレス",
    "お名前",
    "郵便番号",
    "ご住所",
    "電話番号",

    "撮影内容",
    "撮影内容（その他）",

    "撮影場所",
    "ご参加人数",
    "主役のお名前",

    "着付けヘアセットご希望",
    "着付け詳細",
    "着付け場所",
    "着付け場所（同上/その他）",
    "着付け住所（その他）",
    "駐車スペース有無",
    "希望日",
    "希望時間帯",

    "着物レンタル",
    "着物レンタル（その他）",

    "プラン種別",
    "写真館撮影プラン",
    "出張撮影プラン",
    "セットプラン内容",

    "オプション",
    "お支払い方法",
    "当店を何で知りましたか？",
    "当店を何で知りましたか？（その他）",
    "備考",

    "プライバシー同意",
    "キャンセル規約同意",
    "同意日時",
  ];
}

function buildRowObject_(answers, submissionId) {
  const now = new Date();
  const toCsv = (v) => Array.isArray(v) ? v.join("、") : (v ?? "");

  return {
    timestamp: Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    submission_id: submissionId,

    email: answers.email || "",
    name: answers.name || "",
    postal: answers.postal || "",
    address: answers.address || "",
    phone: answers.phone || "",

    shooting_contents: toCsv(answers.shootingContents || []),
    shooting_contents_other: answers.shootingContentsOther || "",

    shooting_place: answers.shootingPlace || "",
    participants: answers.participants || "",
    main_person_name: answers.mainPersonName || "",

    dressing_need: answers.dressingNeed || "",
    dressing_detail: answers.dressingDetail || "",
    dressing_place: answers.dressingPlace || "",
    dressing_address_choice: answers.dressingAddressChoice || "",
    dressing_address_other: answers.dressingAddressOther || "",
    parking_space: answers.parkingSpace || "",
    preferred_date: answers.preferredDate || "",
    preferred_time: answers.preferredTime || "",

    kimono_rental: toCsv(answers.kimonoRentalItems || []),
    kimono_rental_other: answers.kimonoRentalOther || "",

    plan_type: answers.planType || "",
    plan_studio: answers.planStudio || "",
    plan_outcall: answers.planOutcall || "",
    plan_set: toCsv(answers.planSet || []),

    options: toCsv(answers.options || []),
    payment_method: answers.paymentMethod || "",
    how_knew: answers.howKnew || "",
    how_knew_other: answers.howKnewOther || "",
    message: answers.message || "",

    privacy_agree: !!answers.privacyAgree,
    cancel_agree: !!answers.cancelAgree,
    agree_timestamp: Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    terms_version: CONFIG.TERMS_VERSION,
  };
}

function ensureHeaderRow_(sheet, headers) {
  const lastCol = sheet.getLastColumn();
  const firstRow = (lastCol > 0) ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const isEmpty = firstRow.join("").trim() === "";

  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }

  const existing = firstRow.filter(x => x !== "");
  if (existing.length < headers.length) {
    const missing = headers.slice(existing.length);
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function buildAdminMailBody_(a, submissionId) {
  const lines = [];
  lines.push("ご予約フォームが送信されました。");
  lines.push(`送信ID：${submissionId}`);
  lines.push("");
  lines.push("【同意】");
  lines.push(`- 個人情報：${a.privacyAgree ? "同意" : "未同意"}`);
  lines.push(`- キャンセル：${a.cancelAgree ? "同意" : "未同意"}`);
  lines.push("");
  lines.push("【回答内容】");
  lines.push(renderAnswerText_(a));
  return lines.join("\n");
}

function buildCustomerMailBody_(a, submissionId) {
  const lines = [];
  lines.push(CONFIG.CUSTOMER_BODY_HEADER);
  lines.push(`送信ID：${submissionId}`);
  lines.push("");
  lines.push("【回答内容】");
  lines.push(renderAnswerText_(a));
  lines.push("");
  lines.push(CONFIG.CUSTOMER_BODY_FOOTER);
  return lines.join("\n");
}

function toHtmlBody_(text) {
  const safe = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^ +/gm, (m) => "&nbsp;".repeat(m.length))
    .replace(/\n/g, "<br>");

  return `<html><body style="margin:0;padding:0;font-family:Arial,'Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif;font-size:14px;line-height:1.7;color:#222;">${safe}</body></html>`;
}

function renderAnswerText_(a) {
  const toCsv = (v) => Array.isArray(v) ? v.join("、") : (v ?? "");
  const toAgree = (v) => v ? "同意" : "未同意";

  function section_(title, rows){
    const filtered = rows.filter(([_, v]) => String(v ?? "").trim() !== "");
    if (filtered.length === 0) return "";

    const lines = [
      "━━━━━━━━━━━━━━",
      `■ ${title}`,
      "━━━━━━━━━━━━━━"
    ];
    filtered.forEach(([k, v]) => {
    if (k) {
    lines.push(`  ${k}：${v}`);
    } else {
    lines.push(`  ${v}`); // ← コロンなし
    }
    });
    return lines.join("\n");
  }

  function pushLabeledValueOrList_(lines, label, rawValue) {
    const normalize = (str) =>
     String(str ?? "")
      .replace(/\r?\n/g, " ")  // ← 改行をスペースに変換
      .replace(/\s+/g, " ")    // ← 余分なスペースも整理
      .trim();

     if (Array.isArray(rawValue)) {
     const values = rawValue
      .map((x) => normalize(x))
      .filter((x) => x !== "");

     if (values.length === 0) return;

     // ★1行表示に統一（おすすめ）
     lines.push(`  ${label}：${values.join("、")}`);
     return;
     }

     const value = normalize(rawValue);
     if (!value) return;

     lines.push(`  ${label}：${value}`);
     }

     function buildPlanProductSection_() {
     const lines = [
      "━━━━━━━━━━━━━━",
      "■ プラン・商品",
      "━━━━━━━━━━━━━━"
    ];
    let hasContent = false;

    const kimonoItems = (Array.isArray(a.kimonoRentalItems) ? a.kimonoRentalItems : [])
      .map((x) => String(x ?? "").trim())
      .filter((x) => x !== "")
      .map((x) => (x === "その他"
        ? `その他（${String(a.kimonoRentalOther || "").trim()}）`
        : x));
    if (kimonoItems.length > 0) {
      pushLabeledValueOrList_(lines, "着物レンタル希望", kimonoItems);
      hasContent = true;
      lines.push("");
    }

    const planType = String(a.planType || "").trim();
    if (planType) {
      lines.push(`  撮影プラン：${planType}`);
      hasContent = true;
    }

    if (planType.startsWith("写真館撮影")) {
      pushLabeledValueOrList_(lines, "写真館プラン", a.planStudio);
      if (String(a.planStudio || "").trim()) hasContent = true;
    } else if (planType.startsWith("出張撮影")) {
      pushLabeledValueOrList_(lines, "出張プラン", a.planOutcall);
      if (String(a.planOutcall || "").trim()) hasContent = true;
    } else if (planType.startsWith("セットプラン")) {
      const cleanedSet = (Array.isArray(a.planSet) ? a.planSet : [])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x && !x.startsWith("▼"));

      const studioItems = cleanedSet.filter((x) => PLAN_STUDIO_.includes(x));
      const outcallItems = cleanedSet.filter((x) => PLAN_OUTCALL_.includes(x));
      const others = cleanedSet.filter((x) => !PLAN_STUDIO_.includes(x) && !PLAN_OUTCALL_.includes(x));

      if (studioItems.length > 0) {
        lines.push("    ▼ 写真館撮影");
        studioItems.forEach((x) => lines.push(`      ・${x}`));
        hasContent = true;
      }
      if (outcallItems.length > 0) {
        lines.push("    ▼ 出張撮影");
        outcallItems.forEach((x) => lines.push(`      ・${x}`));
        hasContent = true;
      }
      if (others.length > 0) {
        lines.push("    ▼ その他");
        others.forEach((x) => lines.push(`      ・${x}`));
        hasContent = true;
      }
    }
    if (planType) {
      lines.push("");
    }

    const options = (Array.isArray(a.options) ? a.options : [])
      .map((x) => String(x ?? "").trim())
      .filter((x) => x !== "");
    if (options.length > 0) {
      pushLabeledValueOrList_(lines, "パネル/アルバム", options);
      hasContent = true;
      lines.push("");
    }

    return hasContent ? lines.join("\n") : "";
  }

  const blocks = [
    section_("連絡先", [
      ["お名前", a.name],
      ["メールアドレス", a.email],
      ["郵便番号", a.postal],
      ["ご住所", a.address],
      ["お電話番号", a.phone],
    ]),
    section_("撮影について", [
      ["撮影内容", toCsv(a.shootingContents)],
      ["撮影内容（その他）", a.shootingContentsOther],
      ["撮影場所", a.shootingPlace],
      ["ご参加人数", a.participants],
      ["主役のお名前/英字表記", a.mainPersonName],
    ]),
    section_("着付け・日程", [
      ["着付けヘアセット希望", a.dressingNeed],
      ["着付け詳細", a.dressingDetail],
      ["着付け希望場所", a.dressingPlace],
      ["着付け住所（同上/その他）", a.dressingAddressChoice],
      ["着付け住所（その他）", a.dressingAddressOther],
      ["駐車スペース有無", a.parkingSpace],
      ["希望日", a.preferredDate],
      ["希望時間帯", a.preferredTime],
    ]),
    buildPlanProductSection_(),
    section_("お支払い方法", [
      ["", a.paymentMethod],
    ]),
    section_("その他", [
      ["何で知りましたか", a.howKnew],
      ["紹介など（その他）", a.howKnewOther],
      ["備考", a.message],
    ]),
    section_("同意", [
      ["個人情報", toAgree(!!a.privacyAgree)],
      ["キャンセル規定", toAgree(!!a.cancelAgree)],
    ]),
  ].filter(Boolean);

  return blocks.join("\n\n");
}

function maskEmail_(email) {
  const firstEmail = String(email).split(",")[0].trim();
  const [user, domain] = firstEmail.split("@");
  if (!domain) return email;
  const head = user.slice(0, 1);
  return `${head}***@${domain}`;
}

function getAllowedSlotLabels_() {
  return (CONFIG.SLOT_LABELS || [])
    .map((v) => String(v || "").trim())
    .filter((v) => /^\d{2}:\d{2}$/.test(v))
    .sort((a, b) => {
      const [ah, am] = a.split(":").map(Number);
      const [bh, bm] = b.split(":").map(Number);
      return (ah * 60 + am) - (bh * 60 + bm);
    });
}

function getCalendar_() {
  const id = String(CONFIG.CALENDAR_ID || "primary").trim();
  if (!id || id === "primary") return CalendarApp.getDefaultCalendar();
  const cal = CalendarApp.getCalendarById(id);
  if (!cal) throw new Error("カレンダー設定が不正です。");
  return cal;
}

function parseDateParts_(dateStr) {
  const s = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error("日付パラメータが不正です。");
  }
  const [y, m, d] = s.split("-").map((n) => Number(n));
  const check = new Date(y, m - 1, d);
  if (
    check.getFullYear() !== y ||
    check.getMonth() !== m - 1 ||
    check.getDate() !== d
  ) {
    throw new Error("日付パラメータが不正です。");
  }
  return { y, m, d };
}

function getSlotWindow_(dateStr, timeLabel) {
  const { y, m, d } = parseDateParts_(dateStr);
  const allowed = getAllowedSlotLabels_();
  if (!allowed.includes(timeLabel)) {
    throw new Error("時間帯パラメータが不正です。");
  }

  const [hour, minute] = timeLabel.split(":").map(Number);
  const start = new Date(y, m - 1, d, hour, minute, 0, 0);
  const end = new Date(start.getTime() + CONFIG.SLOT_DURATION_MIN * 60 * 1000);
  return { label: timeLabel, start, end };
}

function getSlotWindowsForDate_(dateStr) {
  const { y, m, d } = parseDateParts_(dateStr);
  return getAllowedSlotLabels_().map((label) => {
    const [hour, minute] = label.split(":").map(Number);
    const start = new Date(y, m - 1, d, hour, minute, 0, 0);
    const end = new Date(start.getTime() + CONFIG.SLOT_DURATION_MIN * 60 * 1000);
    return { label, start, end };
  });
}

function rangesOverlap_(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function getAvailableSlots_(dateStr) {
  const { y, m, d } = parseDateParts_(dateStr);
  const day = new Date(y, m - 1, d);
  const slots = getSlotWindowsForDate_(dateStr);
  // 終日イベントは予約枠を塞ぐ意図ではないため除外する
  const events = getCalendar_()
    .getEventsForDay(day)
    .filter((ev) => !ev.isAllDayEvent());

  return slots
    .filter((slot) => !events.some((ev) => rangesOverlap_(slot.start, slot.end, ev.getStartTime(), ev.getEndTime())))
    .map((slot) => slot.label);
}

function isSlotCurrentlyAvailable_(dateStr, timeLabel) {
  const available = getAvailableSlots_(dateStr);
  return available.includes(timeLabel);
}

const PLAN_STUDIO_ = [
  "【１番人気🥇】プレミアムプラン (全データ/A4木製ガラスパネル) ¥57,500→¥46,500",
  "スタンダードプラン (全データ込み) ¥41,000",
  "ライトプラン (5データのみ) ¥30,000 ※データはお客様セレクト"
];

const PLAN_OUTCALL_ = [
  "プレミアムプラン (全データ/2L木製ガラスパネル/アルバム10P Mサイズ) ¥75,000→¥69,800",
  "【１番人気🥇】スタンダードプラン(全データ/2L木製ガラスパネル/2面台紙) ¥65,000→¥59,800",
  "スマートプラン(全データ/2L木製ガラスパネル) ¥40,000"
];
