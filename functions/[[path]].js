// functions/[[path]].js
// 目标：Pages Functions 运行，1:1 还原原始 Worker 的样式和逻辑，并限制只允许 CN 访问。

const CONFIG = { KV_TTL: 3600 }

// ====================================================================
// === 原始 Worker 代码的辅助函数和路由处理函数 (从您的 movecar.js 复制) ===
// ====================================================================

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

// 渲染主页 (1:1 还原样式)
function renderMainPage(origin, PHONE_NUMBER) {
    const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0">
        <title>挪车找人</title>
        <style>
            body { 
                font-family: 'PingFang SC', 'Helvetica Neue', Helvetica, Arial, sans-serif; 
                background-color: #f0f2f5; 
                padding: 0; 
                margin: 0; 
                text-align: center;
            }
            .header {
                background-color: #28a745;
                color: white;
                padding: 40px 20px;
                border-bottom-left-radius: 20px;
                border-bottom-right-radius: 20px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .header h1 {
                margin: 0;
                font-size: 28px;
                font-weight: 600;
            }
            .header p {
                margin-top: 5px;
                font-size: 16px;
                opacity: 0.9;
            }
            .container { 
                background-color: #ffffff; 
                border-radius: 12px; 
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); 
                padding: 25px; 
                max-width: 90%;
                margin: -20px auto 20px;
                position: relative;
            }
            .message-box { 
                margin-bottom: 20px; 
                padding: 15px; 
                background-color: #fff3cd; 
                border: 1px solid #ffeeba;
                border-radius: 8px; 
                font-size: 14px; 
                text-align: left;
                color: #856404;
                line-height: 1.5;
            }
            textarea { 
                width: 100%; 
                height: 100px; 
                padding: 15px; 
                margin-bottom: 20px; 
                border: 1px solid #dcdcdc; 
                border-radius: 8px; 
                box-sizing: border-box; 
                resize: none; 
                font-size: 16px;
                transition: border-color 0.3s;
            }
            textarea:focus {
                border-color: #28a745;
                outline: none;
            }
            button { 
                width: 100%; 
                padding: 15px; 
                margin-top: 10px; 
                border: none; 
                border-radius: 10px; 
                font-size: 18px; 
                font-weight: bold; 
                cursor: pointer; 
                transition: background-color 0.3s, opacity 0.3s; 
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            button:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            .notify-btn { 
                background-color: #007bff; 
                color: white; 
            }
            .notify-btn:hover:not(:disabled) { 
                background-color: #0056b3; 
            }
            .call-btn { 
                background-color: #f0f0f0; 
                color: #333; 
                margin-top: 15px; 
                border: 1px solid #ddd;
            }
            .call-btn:hover:not(:disabled) { 
                background-color: #e0e0e0; 
            }
            .location-status { 
                margin-bottom: 15px; 
                font-size: 15px; 
                color: #555;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
            }
            .loading { 
                border: 3px solid #f3f3f3; 
                border-top: 3px solid #007bff; 
                border-radius: 50%; 
                width: 18px; 
                height: 18px; 
                animation: spin 1s linear infinite; 
                display: none; 
            }
            @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
            }
            .delay-checkbox { 
                display: flex; 
                align-items: center; 
                justify-content: flex-start;
                margin-top: 10px; 
                margin-bottom: 20px;
                font-size: 14px; 
                color: #555; 
            }
            .delay-checkbox input { 
                margin-right: 8px; 
                transform: scale(1.1);
            }
            .footer {
                margin-top: 30px;
                font-size: 12px;
                color: #999;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🅿️ 挪车找人</h1>
            <p>快速通知车主，请耐心等待</p>
        </div>
        <div class="container">
            <div class="message-box">
                请在此处留言说明情况（例如：我在等您，请尽快）
            </div>
            <textarea id="message" placeholder="输入留言（选填）"></textarea>

            <div class="location-status">
                <span id="location-status">📍 尝试获取位置信息...</span>
                <div class="loading" id="loading"></div>
            </div>
            
            <div class="delay-checkbox">
                <input type="checkbox" id="delay-send">
                <label for="delay-send">若车主 30 秒内未响应，是否再次发送通知?</label>
            </div>

            <button class="notify-btn" id="notify-button" disabled>发送挪车通知</button>
            
            <a href="tel:${phone}" style="text-decoration: none;">
                <button class="call-btn">直接打电话给车主（${phone}）</button>
            </a>
            
        </div>
        <div class="footer">
            Powered by Cloudflare Worker
        </div>

        <script>
            const messageInput = document.getElementById('message');
            const notifyButton = document.getElementById('notify-button');
            const locationStatusText = document.getElementById('location-status');
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
                locationStatusText.textContent = '尝试获取位置信息...';
                updateUI(false);

                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (position) => {
                            loading.style.display = 'none';
                            requesterLocation = {
                                lat: position.coords.latitude,
                                lng: position.coords.longitude
                            };
                            locationStatusText.innerHTML = '✅ 位置获取成功。**通知将附带您的位置**。';
                            updateUI(true);
                        },
                        (error) => {
                            loading.style.display = 'none';
                            requesterLocation = null;
                            locationStatusText.innerHTML = '❌ 无法获取位置（请检查权限）。**仍可发送通知**。';
                            updateUI(true);
                            console.error('Geolocation Error:', error);
                        },
                        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                    );
                } else {
                    loading.style.display = 'none';
                    locationStatusText.innerHTML = '❌ 浏览器不支持地理定位。';
                    updateUI(true);
                }
            }

            notifyButton.addEventListener('click', async () => {
                notifyButton.disabled = true;
                notifyButton.textContent = '发送中...';

                const payload = {
                    message: messageInput.value || '车旁有人等待，请尽快挪车',
                    location: requesterLocation,
                    delayed: delayCheckbox.checked 
                };

                try {
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok) {
                        alert('✅ 通知已发送！车主已收到挪车请求。');
                    } else {
                        const errorData = await response.json();
                        alert(\`❌ 通知失败！(\${errorData.error})\`);
                    }
                } catch (error) {
                    alert(\`❌ 通知发送失败，请检查网络或配置: \${error.message}\`);
                } finally {
                    notifyButton.textContent = '发送挪车通知';
                    notifyButton.disabled = false;
                }
            });

            document.addEventListener('DOMContentLoaded', getLocation);
        </script>
    </body>
    </html>
    `;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// 渲染车主确认页 (1:1 还原样式)
async function renderOwnerPage(MOVE_CAR_STATUS) {
    const requesterLocationData = await MOVE_CAR_STATUS.get('requester_location');
    const requesterLocation = requesterLocationData ? JSON.parse(requesterLocationData) : null;

    const mapHtml = requesterLocation 
        ? `<div class="map-link-group">
             <p>请求人位置：</p>
             <a href="${requesterLocation.amapUrl}" target="_blank" class="map-btn amap-btn">高德地图导航</a>
             <a href="${requesterLocation.appleUrl}" target="_blank" class="map-btn apple-btn">苹果地图导航</a>
           </div>`
        : '<p class="info-text">⚠️ 请求人未提供位置信息。</p>';

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0">
        <title>挪车确认</title>
        <style>
            body { 
                font-family: 'PingFang SC', 'Helvetica Neue', Helvetica, Arial, sans-serif; 
                background-color: #f0f2f5; 
                padding: 0; 
                margin: 0; 
                text-align: center; 
            }
            .header {
                background-color: #dc3545;
                color: white;
                padding: 40px 20px;
                border-bottom-left-radius: 20px;
                border-bottom-right-radius: 20px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .header h1 {
                margin: 0;
                font-size: 28px;
                font-weight: 600;
            }
            .header p {
                margin-top: 5px;
                font-size: 16px;
                opacity: 0.9;
            }
            .container { 
                background-color: #ffffff; 
                border-radius: 12px; 
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); 
                padding: 25px; 
                max-width: 90%;
                margin: -20px auto 20px;
                position: relative;
            }
            h2 { 
                color: #333; 
                margin-top: 0; 
                font-size: 20px; 
                margin-bottom: 10px;
            }
            .status-text { 
                color: #007bff; 
                font-weight: 500; 
                margin-bottom: 30px; 
                font-size: 15px;
            }
            button { 
                width: 100%; 
                padding: 18px; 
                margin-top: 25px; 
                border: none; 
                border-radius: 10px; 
                font-size: 18px; 
                font-weight: bold; 
                cursor: pointer; 
                transition: background-color 0.3s; 
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .confirm-btn { 
                background-color: #28a745; 
                color: white; 
            }
            .confirm-btn:hover { 
                background-color: #1e7e34; 
            }
            .map-link-group { 
                margin-top: 20px; 
                padding: 15px; 
                background-color: #e9ecef; 
                border-radius: 8px; 
            }
            .map-link-group p { 
                color: #555; 
                margin-top: 0; 
                font-size: 14px; 
                font-weight: 500;
            }
            .map-btn { 
                display: block; 
                padding: 12px; 
                margin-top: 10px; 
                border-radius: 6px; 
                text-decoration: none; 
                font-weight: bold; 
                font-size: 16px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
            }
            .amap-btn { 
                background-color: #17b3a3; 
                color: white; 
            }
            .apple-btn { 
                background-color: #555; 
                color: white; 
            }
            .info-text { 
                color: #dc3545; 
                font-weight: bold; 
                margin-top: 20px; 
            }
            .loading { 
                border: 3px solid #f3f3f3; 
                border-top: 3px solid #28a745; 
                border-radius: 50%; 
                width: 18px; 
                height: 18px; 
                animation: spin 1s linear infinite; 
                display: none; 
                margin: 10px auto;
            }
            @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🚨 紧急挪车请求</h1>
            <p>请您尽快处理，避免不必要的麻烦</p>
        </div>
        <div class="container">
            <h2>请求人正在等待</h2>
            <p class="status-text">请点击确认按钮并前往挪车。</p>

            ${mapHtml}

            <button class="confirm-btn" id="confirm-button">我已确认，正去挪车/回复</button>
            <div class="loading" id="loading"></div>
            
        </div>

        <script>
            const confirmButton = document.getElementById('confirm-button');
            const loading = document.getElementById('loading');
            const apiUrl = '/api/owner-confirm';

            let ownerLocation = null;
            
            function confirmAction() {
                loading.style.display = 'block';
                confirmButton.disabled = true;
                confirmButton.textContent = '正在提交确认...';

                // 尝试获取车主位置
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (position) => {
                            ownerLocation = {
                                lat: position.coords.latitude,
                                lng: position.coords.longitude
                            };
                            sendConfirmation(ownerLocation);
                        },
                        (error) => {
                            console.warn('Geolocation failed for owner. Sending confirmation without location.', error);
                            sendConfirmation(null); // 在无位置信息的情况下也发送确认
                        },
                        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
                    );
                } else {
                    sendConfirmation(null);
                }
            }

            async function sendConfirmation(location) {
                try {
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ location: location })
                    });

                    if (response.ok) {
                        document.querySelector('.container').innerHTML = 
                            '<h1 style="color:#28a745; font-size: 28px;">✅ 挪车请求已确认</h1>' +
                            '<p style="color:#28a745; font-weight: 500; font-size: 16px; margin-top: 15px;">您已成功确认。请求人将收到通知，请尽快前往！</p>' +
                            '<p style="font-size: 14px; color:#999; margin-top: 30px;">（此页面已失效，无需重复操作）</p>';
                    } else {
                        alert('❌ 确认失败，请重试。');
                        confirmButton.disabled = false;
                        confirmButton.textContent = '我已确认，正去挪车/回复';
                    }
                } catch (error) {
                    alert(\`❌ 确认提交失败: \${error.message}\`);
                    confirmButton.disabled = false;
                    confirmButton.textContent = '我已确认，正去挪车/回复';
                } finally {
                    loading.style.display = 'none';
                }
            }

            confirmButton.addEventListener('click', confirmAction);
        </script>
    </body>
    </html>
    `;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ===================================
// === Pages Functions 适配入口点 ===
// ===================================

/**
 * 核心请求处理函数 (原 Worker 的逻辑)
 */
async function handleRequest(request, env) {
    
    // 1. 地域限制逻辑 (只允许中国地区访问)
    const country = request.cf?.country;
    if (country && country !== 'CN') {
        return new Response('Access Denied', { status: 403 });
    }
    
    // 2. 绑定和环境变量
    const MOVE_CAR_STATUS = env.MOVE_CAR_STATUS;
    const BARK_URL = env.BARK_URL;
    const PHONE_NUMBER = env.PHONE_NUMBER;

    const url = new URL(request.url);
    const path = url.pathname;
    
    // 3. 核心路由分发
    if (path === '/api/notify' && request.method === 'POST') {
        return handleNotify(request, url, MOVE_CAR_STATUS, BARK_URL);
    }

    if (path === '/api/get-location') {
        return handleGetLocation(MOVE_CAR_STATUS);
    }

    if (path === '/api/owner-confirm' && request.method === 'POST') {
        return handleOwnerConfirmAction(request, MOVE_CAR_STATUS);
    }

    if (path === '/api/check-status') {
        const status = await MOVE_CAR_STATUS.get('notify_status');
        const ownerLocation = await MOVE_CAR_STATUS.get('owner_location');
        return new Response(JSON.stringify({
            status: status || 'waiting',
            ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (path === '/owner-confirm') {
        return renderOwnerPage(MOVE_CAR_STATUS); 
    }

    // 渲染主页 (处理所有未匹配的 GET 请求，包括根路径 /)
    return renderMainPage(url.origin, PHONE_NUMBER);
}


// Pages Functions 要求的导出函数
export async function onRequest(context) {
    return handleRequest(context.request, context.env);
}