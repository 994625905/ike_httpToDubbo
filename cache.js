/**
 * create by ikejcwang on 2022.03.07.
 * 本地维护的一个缓存，demo演示，纯粹一个大号json
 */
'use strict';
const defaultCacheLifeTime = 3600000;
const cacheCleanInterval = 1000;
let stopDel = false;
let cache = {};


exports.getCache = function (key = '', extendTTL = false) {
    stopDel = true;
    if (cache[key]){
        if (extendTTL) {
            cache[key].expire = Date.now() + cache[key].life
        }
        return cache[key].value
    }
    return null
};

exports.setCache = function (key = '', value = '', ttl = defaultCacheLifeTime) {
    cache[key] = {
        value: value,
        expire: Date.now() + defaultCacheLifeTime,
        life: defaultCacheLifeTime
    }
};

exports.increase = function (key = '', value = 1, ttl = defaultCacheLifeTime) {
    stopDel = true;
    let v = 0;
    if (cache[key]) {
        v = cache[key].value
    }
    cache[key] = {
        value: v + value,
        expire: Date.now() + defaultCacheLifeTime,
        life: defaultCacheLifeTime
    }
    return cache[key].value;
};

exports.decrease = function (key = '', value = 1, ttl = defaultCacheLifeTime) {
    stopDel = true;
    if (!cache[key]) {
        return;
    }
    if (cache[key].value === 0) {
        delete cache[key];
        return;
    }
    cache[key] = {
        value: cache[key].value - value,
        expire: Date.now() + defaultCacheLifeTime,
        life: defaultCacheLifeTime
    }
    return cache[key].value;
};

setInterval(() => {
    if (!stopDel) {
        let currTime = Date.now();
        for (let key in cache) {
            if (cache[key].expire < currTime) {
                delete cache[key]
            }
        }
    }
}, cacheCleanInterval);