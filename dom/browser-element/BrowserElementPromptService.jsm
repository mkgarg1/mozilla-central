/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
/* vim: set ft=javascript : */

"use strict";

let Cu = Components.utils;
let Ci = Components.interfaces;
let Cc = Components.classes;
let Cr = Components.results;
let Cm = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

let EXPORTED_SYMBOLS = ["BrowserElementPromptService"];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

function debug(msg) {
  //dump("BrowserElementPromptService - " + msg + "\n");
}

function BrowserElementPrompt(win, browserElementChild) {
  this._win = win;
  this._browserElementChild = browserElementChild;
}

BrowserElementPrompt.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIPrompt]),

  alert: function(title, text) {
    this._browserElementChild.showModalPrompt(
      this._win, {promptType: "alert", title: title, message: text, returnValue: undefined});
  },

  alertCheck: function(title, text, checkMsg, checkState) {
    // Treat this like a normal alert() call, ignoring the checkState.  The
    // front-end can do its own suppression of the alert() if it wants.
    this.alert(title, text);
  },

  confirm: function(title, text) {
    return this._browserElementChild.showModalPrompt(
      this._win, {promptType: "confirm", title: title, message: text, returnValue: undefined});
  },

  confirmCheck: function(title, text, checkMsg, checkState) {
    return this.confirm(title, text);
  },

  confirmEx: function(title, text, buttonFlags, button0Title, button1Title, button2Title, checkMsg, checkState) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  prompt: function(title, text, value, checkMsg, checkState) {
    let rv = this._browserElementChild.showModalPrompt(
      this._win,
      { promptType: "prompt",
        title: title,
        message: text,
        initialValue: value.value,
        returnValue: null });

    value.value = rv;

    // nsIPrompt::Prompt returns true if the user pressed "OK" at the prompt,
    // and false if the user pressed "Cancel".
    //
    // BrowserElementChild returns null for "Cancel" and returns the string the
    // user entered otherwise.
    return rv !== null;
  },

  promptUsernameAndPassword: function(title, text, username, password, checkMsg, checkState) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  promptPassword: function(title, text, password, checkMsg, checkState) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  select: function(title, text, aCount, aSelectList, aOutSelection) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },
};


function BrowserElementAuthPrompt() {
}

BrowserElementAuthPrompt.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAuthPrompt2]),

  promptAuth: function promptAuth(channel, level, authInfo) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  asyncPromptAuth: function asyncPromptAuth(channel, callback, context, level, authInfo) {
    debug("asyncPromptAuth");

    // The cases that we don't support now.
    if ((authInfo.flags & Ci.nsIAuthInformation.AUTH_PROXY) &&
        (authInfo.flags & Ci.nsIAuthInformation.ONLY_PASSWORD)) {
      throw Cr.NS_ERROR_FAILURE;
    }

    let frame = this._getFrameFromChannel(channel);
    if (!frame) {
      debug("Cannot get frame, asyncPromptAuth fail");
      throw Cr.NS_ERROR_FAILURE;
    }

    let browserElementParent =
      BrowserElementPromptService.getBrowserElementParentForFrame(frame);

    if (!browserElementParent) {
      debug("Failed to load browser element parent.");
      throw Cr.NS_ERROR_FAILURE;
    }

    let consumer = {
      QueryInterface: XPCOMUtils.generateQI([Ci.nsICancelable]),
      callback: callback,
      context: context,
      cancel: function() {
        this.callback.onAuthCancelled(this.context, false);
        this.callback = null;
        this.context = null;
      }
    };

    let [hostname, httpRealm] = this._getAuthTarget(channel, authInfo);
    let hashKey = level + "|" + hostname + "|" + httpRealm;
    let asyncPrompt = this._asyncPrompts[hashKey];
    if (asyncPrompt) {
      asyncPrompt.consumers.push(consumer);
      return consumer;
    }

    asyncPrompt = {
      consumers: [consumer],
      channel: channel,
      authInfo: authInfo,
      level: level,
      inProgress: false,
      browserElementParent: browserElementParent
    };

    this._asyncPrompts[hashKey] = asyncPrompt;
    this._doAsyncPrompt();
    return consumer;
  },

  // Utilities for nsIAuthPrompt2 ----------------

  _asyncPrompts: {},
  _asyncPromptInProgress: new WeakMap(),
  _doAsyncPrompt: function() {
    // Find the key of a prompt whose browser element parent does not have
    // async prompt in progress.
    let hashKey = null;
    for (let key in this._asyncPrompts) {
      let prompt = this._asyncPrompts[key];
      if (!this._asyncPromptInProgress.get(prompt.browserElementParent)) {
        hashKey = key;
        break;
      }
    }

    // Didn't find an available prompt, so just return.
    if (!hashKey)
      return;

    let prompt = this._asyncPrompts[hashKey];
    let [hostname, httpRealm] = this._getAuthTarget(prompt.channel,
                                                    prompt.authInfo);

    this._asyncPromptInProgress.set(prompt.browserElementParent, true);
    prompt.inProgress = true;

    let self = this;
    let callback = function(ok, username, password) {
      debug("Async auth callback is called, ok = " +
            ok + ", username = " + username);

      // Here we got the username and password provided by embedder, or
      // ok = false if the prompt was cancelled by embedder.
      delete self._asyncPrompts[hashKey];
      prompt.inProgress = false;
      self._asyncPromptInProgress.delete(prompt.browserElementParent);

      // Fill authentication information with username and password provided
      // by user.
      let flags = prompt.authInfo.flags;
      if (username) {
        if (flags & Ci.nsIAuthInformation.NEED_DOMAIN) {
          // Domain is separated from username by a backslash
          let idx = username.indexOf("\\");
          if (idx == -1) {
            prompt.authInfo.username = username;
          } else {
            prompt.authInfo.domain   = username.substring(0, idx);
            prompt.authInfo.username = username.substring(idx + 1);
          }
        } else {
          prompt.authInfo.username = username;
        }
      }

      if (password) {
        prompt.authInfo.password = password;
      }

      for each (let consumer in prompt.consumers) {
        if (!consumer.callback) {
          // Not having a callback means that consumer didn't provide it
          // or canceled the notification.
          continue;
        }

        try {
          if (ok) {
            debug("Ok, calling onAuthAvailable to finish auth");
            consumer.callback.onAuthAvailable(consumer.context, prompt.authInfo);
          } else {
            debug("Cancelled, calling onAuthCancelled to finish auth.");
            consumer.callback.onAuthCancelled(consumer.context, true);
          }
        } catch (e) { /* Throw away exceptions caused by callback */ }
      }

      // Process the next prompt, if one is pending.
      self._doAsyncPrompt();
    };

    let runnable = {
      run: function() {
        // Call promptAuth of browserElementParent, to show the prompt.
        prompt.browserElementParent.promptAuth(
          self._createAuthDetail(prompt.channel, prompt.authInfo),
          callback);
      }
    }

    Services.tm.currentThread.dispatch(runnable, Ci.nsIThread.DISPATCH_NORMAL);
  },

  _getFrameFromChannel: function(channel) {
    let loadContext = channel.notificationCallbacks.getInterface(Ci.nsILoadContext);
    return loadContext.topFrameElement;
  },

  _createAuthDetail: function(channel, authInfo) {
    let [hostname, httpRealm] = this._getAuthTarget(channel, authInfo);
    return {
      host:             hostname,
      realm:            httpRealm,
      username:         authInfo.username,
      isOnlyPassword:   !!(authInfo.flags & Ci.nsIAuthInformation.ONLY_PASSWORD)
    };
  },

  _getAuthTarget : function (channel, authInfo) {
    let hostname = this._getFormattedHostname(channel.URI);

    // If a HTTP WWW-Authenticate header specified a realm, that value
    // will be available here. If it wasn't set or wasn't HTTP, we'll use
    // the formatted hostname instead.
    let realm = authInfo.realm;
    if (!realm)
      realm = hostname;

    return [hostname, realm];
  },

  _getFormattedHostname : function(uri) {
    let scheme = uri.scheme;
    let hostname = scheme + "://" + uri.host;

    // If the URI explicitly specified a port, only include it when
    // it's not the default. (We never want "http://foo.com:80")
    let port = uri.port;
    if (port != -1) {
      let handler = Services.io.getProtocolHandler(scheme);
      if (port != handler.defaultPort)
        hostname += ":" + port;
    }
    return hostname;
  }
};


function AuthPromptWrapper(oldImpl, browserElementImpl) {
  this._oldImpl = oldImpl;
  this._browserElementImpl = browserElementImpl;
}

AuthPromptWrapper.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAuthPrompt2]),
  promptAuth: function(channel, level, authInfo) {
    if (this._canGetParentElement(channel)) {
      return this._browserElementImpl.promptAuth(channel, level, authInfo);
    } else {
      return this._oldImpl.promptAuth(channel, level, authInfo);
    }
  },

  asyncPromptAuth: function(channel, callback, context, level, authInfo) {
    if (this._canGetParentElement(channel)) {
      return this._browserElementImpl.asyncPromptAuth(channel, callback, context, level, authInfo);
    } else {
      return this._oldImpl.asyncPromptAuth(channel, callback, context, level, authInfo);
    }
  },

  _canGetParentElement: function(channel) {
    try {
      let frame = channel.notificationCallbacks.getInterface(Ci.nsILoadContext).topFrameElement;
      if (!frame)
        return false;

      if (!BrowserElementPromptService.getBrowserElementParentForFrame(frame))
        return false;

      return true;
    } catch (e) {
      return false;
    }
  }
};

function BrowserElementPromptFactory(toWrap) {
  this._wrapped = toWrap;
}

BrowserElementPromptFactory.prototype = {
  classID: Components.ID("{24f3d0cf-e417-4b85-9017-c9ecf8bb1299}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIPromptFactory]),

  _mayUseNativePrompt: function() {
    try {
      return Services.prefs.getBoolPref("browser.prompt.allowNative");
    } catch (e) {
      // This properity is default to true.
      return true;
    }
  },

  _getNativePromptIfAllowed: function(win, iid, err) {
    if (this._mayUseNativePrompt())
      return this._wrapped.getPrompt(win, iid);
    else {
      // Not allowed, throw an exception.
      throw err;
    }
  },

  getPrompt: function(win, iid) {
    // It is possible for some object to get a prompt without passing
    // valid reference of window, like nsNSSComponent. In such case, we
    // should just fall back to the native prompt service
    if (!win)
      return this._getNativePromptIfAllowed(win, iid, Cr.NS_ERROR_INVALID_ARG);

    if (iid.number != Ci.nsIPrompt.number &&
        iid.number != Ci.nsIAuthPrompt2.number) {
      debug("We don't recognize the requested IID (" + iid + ", " +
            "allowed IID: " +
            "nsIPrompt=" + Ci.nsIPrompt + ", " +
            "nsIAuthPrompt2=" + Ci.nsIAuthPrompt2 + ")");
      return this._getNativePromptIfAllowed(win, iid, Cr.NS_ERROR_INVALID_ARG);
    }

    // Try to find a BrowserElementChild for the window.
    let browserElementChild =
      BrowserElementPromptService.getBrowserElementChildForWindow(win);

    if (iid.number === Ci.nsIAuthPrompt2.number) {
      debug("Caller requests an instance of nsIAuthPrompt2.");

      if (browserElementChild) {
        // If we are able to get a BrowserElementChild, it means that
        // the auth prompt is for a mozbrowser. Therefore we don't need to
        // fall back.
        return new BrowserElementAuthPrompt().QueryInterface(iid);
      }

      // Because nsIAuthPrompt2 is called in parent process. If caller
      // wants nsIAuthPrompt2 and we cannot get BrowserElementchild,
      // it doesn't mean that we should fallback. It is possible that we can
      // get the BrowserElementParent from nsIChannel that passed to
      // functions of nsIAuthPrompt2.
      if (this._mayUseNativePrompt()) {
        return new AuthPromptWrapper(
            this._wrapped.getPrompt(win, iid),
            new BrowserElementAuthPrompt().QueryInterface(iid))
          .QueryInterface(iid);
      } else {
        // Falling back is not allowed, so we don't need wrap the
        // BrowserElementPrompt.
        return new BrowserElementAuthPrompt().QueryInterface(iid);
      }
    }

    if (!browserElementChild) {
      debug("We can't find a browserElementChild for " +
            win + ", " + win.location);
      return this._getNativePromptIfAllowed(win, iid, Cr.NS_ERROR_FAILURE);
    }

    debug("Returning wrapped getPrompt for " + win);
    return new BrowserElementPrompt(win, browserElementChild)
                                   .QueryInterface(iid);
  }
};

let BrowserElementPromptService = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  _init: function() {
    this._browserElementParentMap = new WeakMap();

    var os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    os.addObserver(this, "outer-window-destroyed", /* ownsWeak = */ true);

    // Wrap the existing @mozilla.org/prompter;1 implementation.
    var contractID = "@mozilla.org/prompter;1";
    var oldCID = Cm.contractIDToCID(contractID);
    var newCID = BrowserElementPromptFactory.prototype.classID;
    var oldFactory = Cm.getClassObject(Cc[contractID], Ci.nsIFactory);

    if (oldCID == newCID) {
      debug("WARNING: Wrapped prompt factory is already installed!");
      return;
    }

    Cm.unregisterFactory(oldCID, oldFactory);

    var oldInstance = oldFactory.createInstance(null, Ci.nsIPromptFactory);
    var newInstance = new BrowserElementPromptFactory(oldInstance);

    var newFactory = {
      createInstance: function(outer, iid) {
        if (outer != null) {
          throw Cr.NS_ERROR_NO_AGGREGATION;
        }
        return newInstance.QueryInterface(iid);
      }
    };
    Cm.registerFactory(newCID,
                       "BrowserElementPromptService's prompter;1 wrapper",
                       contractID, newFactory);

    debug("Done installing new prompt factory.");
  },

  _getOuterWindowID: function(win) {
    return win.QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIDOMWindowUtils)
              .outerWindowID;
  },

  _browserElementChildMap: {},
  mapWindowToBrowserElementChild: function(win, browserElementChild) {
    this._browserElementChildMap[this._getOuterWindowID(win)] = browserElementChild;
  },

  getBrowserElementChildForWindow: function(win) {
    // We only have a mapping for <iframe mozbrowser>s, not their inner
    // <iframes>, so we look up win.top below.  window.top (when called from
    // script) respects <iframe mozbrowser> boundaries.
    return this._browserElementChildMap[this._getOuterWindowID(win.top)];
  },

  mapFrameToBrowserElementParent: function(frame, browserElementParent) {
    this._browserElementParentMap.set(frame, browserElementParent);
  },

  getBrowserElementParentForFrame: function(frame) {
    return this._browserElementParentMap.get(frame);
  },

  _observeOuterWindowDestroyed: function(outerWindowID) {
    let id = outerWindowID.QueryInterface(Ci.nsISupportsPRUint64).data;
    debug("observeOuterWindowDestroyed " + id);
    delete this._browserElementChildMap[outerWindowID.data];
  },

  observe: function(subject, topic, data) {
    switch(topic) {
    case "outer-window-destroyed":
      this._observeOuterWindowDestroyed(subject);
      break;
    default:
      debug("Observed unexpected topic " + topic);
    }
  }
};

BrowserElementPromptService._init();
