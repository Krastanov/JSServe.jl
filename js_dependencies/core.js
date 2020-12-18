const on_update_observables_callbacks = [];
const registered_observables = {};
const observable_callbacks = {};
// Save some bytes by using ints for switch variable
const UpdateObservable = '0';
const OnjsCallback = '1';
const EvalJavascript = '2';
const JavascriptError = '3';
const JavascriptWarning = '4';
const JSDoneLoading = '8';
const FusedMessage = '9';

function is_list(value) {
    return value && typeof value === 'object' && value.constructor === Array;
}

function is_dict(value) {
    return value && typeof value === 'object';
}

function randhex() {
    return (Math.random() * 16 | 0).toString(16);
}

// TODO use a secure library for this shit
function rand4hex() {
    return randhex() + randhex() + randhex() + randhex();
}

function materialize(data) {
    // if is a node attribute
    if (is_list(data)) {
        return data.map(materialize);
    } else if (data.tag) {
        var node = document.createElement(data.tag);
        for (var key in data) {
            if (key == 'class') {
                node.className = data[key];
            } else if (key != 'children' && key != 'tag') {
                node.setAttribute(key, data[key]);
            }
        }
        for (var idx in data.children) {
            var child = data.children[idx];
            if (is_dict(child)) {
                node.appendChild(materialize(child));
            } else {
                if(data.tag == "script"){
                    node.text = child;
                } else {
                    node.innerText = child;
                }
            }
        }
        return node;
    } else { // anything else is used as is!
        return data;
    }
}

function deserialize_js(data) {
    if (is_list(data)) {
        return data.map(deserialize_js);
    } else if (is_dict(data)) {
        if ('__javascript_type__' in data) {
            if (data.__javascript_type__ == 'typed_vector') {
                return data.payload;
            } else if (data.__javascript_type__ == 'DomNode') {
                return document.querySelector('[data-jscall-id="' + data.payload + '"]');
            } else if (data.__javascript_type__ == 'js_code') {
                return data.payload;
            } else if (data.__javascript_type__ == 'Observable') {
                const value = deserialize_js(data.payload.value);
                const id = data.payload.id;
                registered_observables[id] = value;
                return id;
            } else {
                send_error(
                    "Can't deserialize custom type: " + data.__javascript_type__,
                    null
                );
                return undefined;
            }
        } else {
            var result = {};
            for (var k in data) {
                if (data.hasOwnProperty(k)) {
                    result[k] = deserialize_js(data[k]);
                }
            }
            return result;
        }
    } else {
        return data;
    }
}

function get_observable(id) {
    if (id in registered_observables) {
        return registered_observables[id];
    } else {
        throw ("Can't find observable with id: " + id);
    }
}

function on_update(id, callback) {
    register_onjs(callback, id);
}

function send_error(message, exception) {
    console.error(message);
    console.error(exception);
    websocket_send({
        msg_type: JavascriptError,
        message: message,
        exception: String(exception),
        stacktrace: exception == null ? "" : exception.stack
    });
}

function send_warning(message) {
    console.warn(message);
    websocket_send({
        msg_type: JavascriptWarning,
        message: message
    });
}

function sent_done_loading(){
    websocket_send({
        msg_type: JSDoneLoading,
        exception: "null",
    });
};

function update_node_attribute(node, attribute, value) {
  if (node) {
    if (node[attribute] != value) {
      node[attribute] = value;
    }
    return true;
  } else {
    return false; //deregister
  }
}

function run_js_callbacks(id, value) {
    if (id in observable_callbacks) {
        const callbacks = observable_callbacks[id];
        const deregister_calls = [];
        console.log(callbacks);
        for (const i in callbacks) {
            // onjs can return false to deregister itself
            try {
                var register = callbacks[i](value);
                if (register == false) {
                    deregister_calls.push(i);
                }
            } catch (exception) {
                send_error(
                    "Error during running onjs callback\n" +
                    "Callback:\n" +
                    callbacks[i].toString(),
                    exception
                );
            }
        }
        for (var i = 0; i < deregister_calls.length; i++) {
            callbacks.splice(deregister_calls[i], 1);
        }
    }
}

function update_obs(id, value) {
    if (id in registered_observables) {
        try {
            registered_observables[id] = value;
            // call onjs callbacks
            run_js_callbacks(id, value);
            // update Julia side!
            websocket_send({
                msg_type: UpdateObservable,
                id: id,
                payload: value
            });
        } catch (exception) {
            send_error(
                "Error during update_obs with observable " + id,
                exception
            );
        }
        return true;
    } else {
        return false;
    }
}

const session_websocket = [];

function offline_forever() {
    return (session_websocket.length == 1 && session_websocket[0] == null)
}

function ensure_connection() {
    // we lost the connection :(
    if (offline_forever()) {
        return false;
    }

    if (session_websocket.length == 0) {
        console.log("Length of websocket 0");
        // try to connect again!
        setup_connection();
    }
    // check if we have a connection now!
    if (session_websocket.length == 0) {
        console.log("Length of websocket 0 after setup_connection. We assume server is offline");
        // still no connection...
        // Display a warning, that we lost conenction!
        var popup = document.getElementById('WEBSOCKET_CONNECTION_WARNING');
        if (!popup) {
            var doc_root = document.getElementById('application-dom');
            var popup = document.createElement('div');
            popup.id = "WEBSOCKET_CONNECTION_WARNING";
            popup.innerText = "Lost connection to server!";
            doc_root.appendChild(popup);
        }
        popup.style;
        return false;
    }
    return true
}

function websocket_send(data) {
    const has_conenction = ensure_connection();
    if (has_conenction) {
        if (session_websocket[0]) {
            if (session_websocket[0].readyState == 1) {
                session_websocket[0].send(msgpack.encode(data));
            } else {
                console.log("Websocket not in readystate!");
                // wait until in ready state
                setTimeout(() => websocket_send(data), 100);
            }
        } else {
            console.log("Websocket is null!");
            // we're in offline mode!
            return;
        }
    }
}

function register_onjs(f, observable) {
    const callbacks = observable_callbacks[observable] || [];
    callbacks.push(f);
    observable_callbacks[observable] = callbacks;
}

function update_dom_node(dom, html) {
    if (dom) {
        dom.innerHTML = html;
        return true;
    } else {
        //deregister the callback if the observable dom is gone
        return false;
    }
}

function process_message(data) {
    console.log(data)
    let error_message = ""
    try {
        switch (data.msg_type) {
            case UpdateObservable:
                const value = data.payload;
                registered_observables[data.id] = deserialize_js(value);
                // update all onjs callbacks
                run_js_callbacks(data.id, value);
                break;
            case OnjsCallback:
                // register a callback that will executed on js side
                // when observable updates
                const id = data.id;
                const func_func = new Function(
                  "__eval_context__",
                  data.payload.payload.source
                );
                const func_context = deserialize_js(
                  data.payload.payload.context
                );
                const f = func_func(func_context);
                register_onjs(f, id);
                break;
            case EvalJavascript:
                const eval_func = new Function("__eval_context__", data.payload.source);
                const context = deserialize_js(data.payload.context);
                eval_func(context);
                break;
            case FusedMessage:
                const messages = data.payload;
                messages.forEach(process_message);
                break;
            default:
                send_error("Unrecognized message type: " + data.msg_type + ".", null);
        }
        for (let idx in on_update_observables_callbacks){
            on_update_observables_callbacks[idx](value);
        }
    } catch(e) {
        console.log("Error while processing message!")
        console.log(e)
        console.log(data)
    }

}

function get_session_id() {
    // We have one session id, which handles the connection
    // for one APP state
    var session_id = window.js_call_session_id;

    var browser_id = rand4hex();

    // Now, we also need an id for having multiple tabs open in the same browser
    // or for a refresh. this will always be random one...
    // We will create a new websocket connection for any new tab,
    // which will share the same state with the other tabs/refresh
    // var tab_id = rand4hex();
    return session_id + "/" + browser_id; //* "/" * tab_id;
}

function websocket_url() {
    // something like http://127.0.0.1:8081/
    let http_url = window.location.protocol + "//" + window.location.host;
    if (window.websocket_proxy_url) {
        http_url = window.websocket_proxy_url;
    } else if (!window.js_call_session_id) {
        // we're in offline mode!
        return null;
    }
    let ws_url = http_url.replace("http", "ws");
    // now should be like: ws://127.0.0.1:8081/
    if (!ws_url.endsWith("/")) {
        ws_url = ws_url + "/";
    }
    ws_url = ws_url + get_session_id() + "/";
    return ws_url;
}

function setup_connection() {
    // we're in offline mode, dont even try!
    if (offline_forever()){
        console.log("OFFLINE FOREVER")
        return
    }
    var tries = 0;
    function tryconnect(url) {
        if (offline_forever()){
            console.log("OFFLINE FOREVER in tryconnect")
            return
        }
        if (session_websocket.length != 0) {
            throw "Inconsistent state. Already opened a websocket!";
        }
        websocket = new WebSocket(url);
        websocket.binaryType = 'arraybuffer';
        session_websocket.push(websocket);

        websocket.onopen = function() {
            console.log("CONNECTED!!: ", url)
            websocket.onmessage = function(evt) {
                const binary = new Uint8Array(evt.data);
                const data = msgpack.decode(binary);
                process_message(data);
            };
        };

        websocket.onclose = function(evt) {
            console.log("closed websocket connection")
            while (session_websocket.length > 0) {
                session_websocket.pop();
            }
            if (window.dont_even_try_to_reconnect) {
                // ok, we cant even right now and just give up
                session_websocket.push(null);
                return
            }
            console.log("Wesocket close code: " + evt.code);
        };
        websocket.onerror = function(event) {
            console.error("WebSocket error observed:" + event);
            console.log("dont_even_try_to_reconnect: "  + window.dont_even_try_to_reconnect)

            if (tries <= 1) {
                while (session_websocket.length > 0) {
                    session_websocket.pop();
                }
                tries = tries + 1;
                console.log("Retrying to connect the " + tries + " time!");
                setTimeout(() => tryconnect(websocket_url()), 1000);
            } else {
                // ok, we really cant connect and are offline!
                session_websocket.push(null);
            }
        };
    }
    const url = websocket_url();
    if (url) {
        tryconnect(url);
    } else {
        // we're in offline mode!
        session_websocket.push(null);
    }
}

setup_connection();
