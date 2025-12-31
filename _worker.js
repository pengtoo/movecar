// _worker.js - 最终完整且可部署的代码

const CONFIG = { KV_TTL: 3600 }

// ===================================
// === 辅助函数和路由处理函数定义 ===
// ===================================

// WGS-84 转 GCJ-02 (中国国测局坐标系)
function wgs84ToGcj02(lat, lng) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;

    if (outOfChina(lat, lng)) return { lat, lng };

    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
}

function generateMapUrls(lat, lng) {
    const gcj = wgs84ToGcj02(lat, lng);
    return {
        amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
        appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
    };
}

async function handleNotify(request, url, MOVE_CAR_STATUS, BARK_URL) {
    try {
        const body = await request.json();
        const message = body.message || '车旁有人等待';
        const location = body.location || null;
        const delayed = body.delayed || false;

        const confirmUrl = encodeURIComponent(url.origin + '/owner-confirm');

        let notifyBody = '🚗 挪车请求';
        if (message) notifyBody += `\n💬 留言: ${message}`;

        if (location && location.lat && location.lng) {
            const urls = generateMapUrls(location.lat, location.lng);
            notifyBody += '\n📍 已附带位置信息，点击查看';

            await MOVE_CAR_STATUS.put('requester_location', JSON.stringify({
                lat: location.lat,
                lng: location.lng,
                ...urls
            }), { expirationTtl: CONFIG.KV_TTL });
        } else {
            notifyBody += '\n⚠️ 未提供位置信息';
        }

        await MOVE_CAR_STATUS.put('notify_status', 'waiting', { expirationTtl: 600 });

        if (delayed) {
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

        const barkApiUrl = `${BARK_URL}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${confirmUrl}`;

        const barkResponse = await fetch(barkApiUrl);
        if (!barkResponse.ok) throw new Error('Bark API Error');

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
    }
}

async function handleGetLocation(MOVE_CAR_STATUS) {
    const data = await MOVE_CAR_STATUS.get('requester_location');
    if (data) {
        return new Response(data, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'No location' }), { status: 404 });
}

async function handleOwnerConfirmAction(request, MOVE_CAR_STATUS) {
    try {
        const body = await request.json();
        const ownerLocation = body.location || null;

        if (ownerLocation) {
            const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
            await MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
                lat: ownerLocation.lat,
                lng: ownerLocation.lng,
                ...urls,
                timestamp: Date.now()
            }), { expirationTtl: CONFIG.KV_TTL });
        }

        await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// 渲染主页 (已包含完整的 HTML/CSS/JS)
function renderMainPage(origin, PHONE_NUMBER) {
    const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>挪车找人</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: #f7f7f7; padding: 20px; text-align: center; }
            .container { background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 30px; max-width: 400px; margin: 0 auto; }
            h1 { color: #333; margin-bottom: 20px; font-size: 24px; }
            textarea { width: 100%; height: 80px; padding: 10px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; resize: none; }
            button { width: 100%; padding: 12px; margin-top: 10px; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background-color 0.3s; }
            .notify-btn { background-color: #007bff; color: white; }
            .notify-btn:hover { background-color: #0056b3; }
            .call-btn { background-color: #28a745; color: white; margin-top: 20px; }
            .call-btn:hover { background-color: #1e7e34; }
            .location-status { margin-top: 15px; font-size: 14px; color: #555; }
            .loading { border: 4px solid #f3f3f3; border-top: 4px solid #007bff; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 10px auto; display: none; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .delay-checkbox { display: flex; align-items: center; justify-content: center; margin-top: 15px; font-size: 14px; color: #555; }
            .delay-checkbox input { margin-right: 5px; }
            .message-box { margin-top: 20px; padding: 15px; background-color: #e9ecef; border-radius: 8px; font-size: 14px; text-align: left; }
            .message-box p { margin: 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>一键通知车主挪车</h1>
            <div class="message-box">
                <p>请留言说明情况（例如：我在等您，请尽快）</p>
            </div>
            <textarea id="message" placeholder="输入留言（选填）"></textarea>

            <div class="location-status" id="location-status">📍 尝试获取位置信息...</div>
            <div class="loading" id="loading"></div>
            
            <div class="delay-checkbox">
                <input type="checkbox" id="delay-send">
                <label for="delay-send">若车主 30 秒内未响应，再发送一次通知</label>
            </div>

            <button class="notify-btn" id="notify-button" disabled>发送挪车通知</button>
            
            <a href="tel:${phone}" style="text-decoration: none;">
                <button class="call-btn">直接打电话（${phone}）</button>
            </a>
            
        </div>

        <script>
            const messageInput = document.getElementById('message');
            const notifyButton = document.getElementById('notify-button');
            const locationStatus = document.getElementById('location-status');
            const loading = document.getElementById('loading');
            const delayCheckbox = document.getElementById('delay-send');
            const apiUrl = '${origin}/api/notify';

            let requesterLocation = null;

            function updateUI(canNotify) {
                notifyButton.disabled = !canNotify;
                notifyButton.textContent = canNotify ? '发送挪车通知' : '位置信息获取中...';
            }

            function getLocation() {
                loading.style.display = 'block';
                locationStatus.textContent = '📍 尝试获取位置信息...';
                updateUI(false);

                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (position) => {
                            loading.style.display = 'none';
                            requesterLocation = {
                                lat: position.coords.latitude,
                                lng: position.coords.longitude