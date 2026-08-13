function redirectUrl(originalUrl) {
    if (!originalUrl) return originalUrl;

    try {
        if (typeof originalUrl === 'string' && originalUrl.startsWith('//')) originalUrl = originalUrl.replace('//', 'https://')
        const url = new URL(originalUrl, window.location.origin);
        const hostname = url.hostname;

        if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
            url.protocol = 'http:';
            url.host = 'localhost:8099';
            return url.toString();
        }

        if (hostname.endsWith('googlevideo.com') || hostname.endsWith('youtube.com')
            || hostname.endsWith('gstatic.com') || hostname.endsWith('.google.com')
            || hostname.endsWith('.googleapis.com') || hostname.endsWith('googleusercontent.com')
            || hostname.endsWith('.ggpht.com')) {
            return 'http://localhost:8099/cors-bypass/' + url.toString();
        }
    } catch (e) {
        console.error('Failed to parse URL during interception:', e);
    }

    return originalUrl;
}

export default function () {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://localhost:8099/tizentube/storage', false);
        xhr.send();
        if (xhr.status === 200) {
            var data = JSON.parse(xhr.responseText);
            if (data && data.localStorage) {
                for (var k in data.localStorage) {
                    window.localStorage.setItem(k, data.localStorage[k]);
                }
            }
            if (data && data.cookies) {
                var cookies = data.cookies.split(';');
                for (var i = 0; i < cookies.length; i++) {
                    if (cookies[i].trim()) {
                        document.cookie = cookies[i].trim();
                    }
                }
            }
            window.__tizentubeStorageLoaded = true;
        }
    } catch (e) {
        console.error('TizenTube: Failed to load storage from proxy', e);
        window.__tizentubeStorageLoaded = false;
    }
    
    try {
        setInterval(function() {
            if (!window.__tizentubeStorageLoaded) {
                console.warn('TizenTube: Storage was not loaded properly at startup. Skipping save to prevent overwriting proxy storage with empty data.');
                return;
            }
            var ls = {};
            for (var i = 0; i < window.localStorage.length; i++) {
                var key = window.localStorage.key(i);
                ls[key] = window.localStorage.getItem(key);
            }
            var payload = JSON.stringify({ localStorage: ls, cookies: document.cookie });
            var syncXhr = new XMLHttpRequest();
            syncXhr.open('POST', 'http://localhost:8099/tizentube/storage', true);
            syncXhr.setRequestHeader('Content-Type', 'application/json');
            syncXhr.send(payload);
        }, 5000);
    } catch (e) {
        console.error('TizenTube Storage Sync Error:', e);
    }

    // Debug Server: hook console methods to forward logs to the background service
    try {
        var debugEnabled = false;
        try {
            var configStr = window.localStorage.getItem('ytaf-configuration');
            if (configStr) {
                var parsedConfig = JSON.parse(configStr);
                debugEnabled = !!parsedConfig.enableDebugServer;
            }
        } catch (ce) {}

        if (debugEnabled) {
            var debugLogQueue = [];
            var origConsoleLog = console.log;
            var origConsoleWarn = console.warn;
            var origConsoleError = console.error;
            var origConsoleInfo = console.info;

            function hookConsole(level, origFn) {
                console[level] = function() {
                    var args = Array.prototype.slice.call(arguments);
                    var msg = args.map(function(a) {
                        if (typeof a === 'string') return a;
                        try { return JSON.stringify(a); } catch(e) { return String(a); }
                    }).join(' ');
                    debugLogQueue.push({ level: level, message: msg, source: 'client' });
                    return origFn.apply(console, arguments);
                };
            }

            hookConsole('log', origConsoleLog);
            hookConsole('warn', origConsoleWarn);
            hookConsole('error', origConsoleError);
            hookConsole('info', origConsoleInfo);

            // Flush debug logs every 500ms
            setInterval(function() {
                if (debugLogQueue.length === 0) return;
                var batch = debugLogQueue.splice(0, debugLogQueue.length);
                var flushXhr = new XMLHttpRequest();
                flushXhr.open('POST', 'http://localhost:8099/tizentube/debug-log', true);
                flushXhr.setRequestHeader('Content-Type', 'application/json');
                flushXhr.send(JSON.stringify(batch));
            }, 500);

            // Capture unhandled errors
            window.addEventListener('error', function(e) {
                debugLogQueue.push({
                    level: 'error',
                    message: 'Uncaught: ' + (e.message || '') + ' at ' + (e.filename || '') + ':' + (e.lineno || ''),
                    source: 'window.onerror'
                });
            });
            window.addEventListener('unhandledrejection', function(e) {
                debugLogQueue.push({
                    level: 'error',
                    message: 'Unhandled Promise: ' + (e.reason ? (e.reason.message || String(e.reason)) : 'unknown'),
                    source: 'unhandledrejection'
                });
            });
        }
    } catch (de) {}

    const originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            let targetUrl = '';
            let isRequestObject = false;

            if (typeof input === 'string') {
                targetUrl = redirectUrl(input);
            } else if (input instanceof URL) {
                targetUrl = redirectUrl(input.toString());
                input = new URL(targetUrl);
            } else if (input instanceof Request) {
                isRequestObject = true;
                targetUrl = redirectUrl(input.url);
            }

            if (isRequestObject) {
                if (input.method === 'POST' && targetUrl.indexOf('localhost') !== -1) {
                    const modifiedOptions = {
                        method: input.method,
                        headers: new Headers(input.headers),
                        mode: input.mode,
                        credentials: input.credentials,
                    };

                    if (input.body && !input.bodyUsed) {
                        const requestClone = input.clone();
                        return input.clone().arrayBuffer().then(function (buffer) {
                            modifiedOptions.body = buffer;

                            return originalFetch(targetUrl, modifiedOptions);
                        });
                    }

                    return originalFetch(targetUrl, modifiedOptions);
                }

                input = new Request(targetUrl, input);
            }

            return originalFetch.apply(this, [targetUrl, init]);
        };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
        const redirectedUrl = redirectUrl(url);
        if (redirectedUrl !== url) {
            async = true;
        }

        if (async === undefined) {
            async = true;
        }

        return originalOpen.apply(this, [method, redirectedUrl, async, user, password]);
    };

    if (navigator.sendBeacon) {
        const originalSendBeacon = navigator.sendBeacon;
        navigator.sendBeacon = function (url, data) {
            console.log("Beacon data:", data);
            return originalSendBeacon.apply(this, [redirectUrl(url), data]);
        };
    }

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        set: function(value) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
            descriptor.value.call(this, 'src', redirectUrl(value));
        }
    });
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        set: function(value) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
            descriptor.value.call(this, 'src', redirectUrl(value));
        }
    });
}