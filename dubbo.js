/**
 * create by ikejcwang on 2022.03.07.
 * dubbo配置对象
 */
'use struct'
const cache = require('./cache');
const URL = require("url");
const jsTojava = require('js-to-java'); // Java泛化工具
const net = require('net');
const zookeeper = require('node-zookeeper-client');
const querystring = require("querystring");
const Encoder = require('hessian.js').EncoderV2;    // dubbo请求报文的序列化方式
const decoder = require('hessian.js').DecoderV2;    // dubbo响应报文的反序列化方式
const STATIC_BASE_DATA = '0123456789';    // 生产requestId使用
const DUBBO_MESSAGE_MAX_LEN = 8388608; // 8 * 1024 * 1024，dubbo框架默认的报文大小8M，服务端可以配置（dubbo.protocol.dubbo.payload）
const HEADER_LENGTH = 16;   // 协议标准头信息固定16个字节
const FLAG_EVENT = 0x20;
const MAX_SOCKET_QUEUE_SIZE = 3;    // 最大socket队列长度
const PROCESS_HEAD_TEMPLATE = {
    MAGIC: new Uint8Array([0xda, 0xbb]),   // 2个字节，16位，表示dubbo协议
    REQ_WAY_EVENT_SERIALIZATION_ID: {
        REQ_RES: new Uint8Array([0xc2]), // 请求&响应。1个字节，8位 分别表示：1请求，1双向调用，0数据包，00010序列化类型hessian，或者也可以改为11000010
        HEARTBEAT: new Uint8Array([0xe2]), // 心跳动作。1个字节，8位 分别表示：1请求，1双向调用，0数据包，00010序列化类型hessian，或者也可以改为11100010
    },
    STATUS: new Uint8Array([0]),    // 1个字节，8位，表示状态，仅在Req/Res为0才有价值，请求用不到，预先占位
    RPC_REQUEST_ID: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),   // 8个字节，64位，表示RPC请求的唯一ID，预先占位
    DATA_LENGTH: new Uint8Array([0, 0, 0, 0]),  // 4个字节，32位，表示消息体的内容长度，预先占位
}
const HEARTBEAT_DATA = {
    LENGTH: new Uint8Array([0, 0, 0, 0x01]), // 4个字节，32位，心跳探测的数据包长度
    DATA: new Uint8Array([0x1c])            // 心跳探测的消息文本，不做特殊要求
}

/**
 * dubbo规则专属的class
 */
class Dubbo {

    /**
     * 初始化dubbo规则对象
     * @param rule
     */
    constructor(config) {
        if (!config.hosts && (!config.registerCenterHosts || !config.registerCenterType)) {
            throw new Error('DubboService Hosts or RegisterCenter Hosts/Type is required');
        }
        if (!config.interfaceName) {
            throw new Error('DubboService interfaceName is required')
        }
        this.hosts = config.hosts;    // 如果启用了host，表示直连dubbo服务，那么注册中心就无效
        this.registerCenterHosts = config.registerCenterHosts;
        this.registerCenterType = config.registerCenterType;
        this.registerCenterId = this.registerCenterHosts.join(','); // 生成一个注册中心ID，作用于后面的标记探活

        this.interfaceName = config.interfaceName;  // dubbo服务的全类名
        this.methodName = config.methodName;  // 调用的方法名，如果为空，则实际访问的path最后一段即为目标方法名称，用于通配

        this.dubboVersion = config.dubboVersion ? config.dubboVersion : '2.6.0';    // 非必填
        this.version = config.version;    // dubbo服务的注册版本号
        this.group = config.group;    // dubbo服务注册的分组名
        this.token = config.token;    // dubbo服务注册的token
        this.protocol = config.protocol ? config.protocol : 'dubbo';   // 调用协议
        this.timeout = config.timeout ? config.timeout : 3000;  // 调用超时

        this.metas = [];    // 筛选dubbo服务注册的元数据，数组，默认从zk获取到的dubbo服务都是可用的，因为它会自动下线。
        this.exact = false;  // 配置正确的标识，如果没有筛选到可用的元数据，则不进行下一步的初始化动作

        this.init();
    }

    /**
     * 如果填的是hosts：则methodName,version,group,token……都是参数
     * 如果填的是registerCenterHost：则methodName,version,group,token……都是筛选条件
     * @returns {Promise<void>}
     */
    async init() {
        this.exact = true;
        if (this.hosts && this.hosts.length > 0) {
            this.hosts.forEach(item => {
                this.metas.push({
                    host: item.hostname,
                    port: item.port,
                    dubboVersion: this.dubboVersion,   // dubbo框架版本,非必填
                    version: this.version,
                    group: this.group,
                    token: this.token,
                    timeout: this.timeout,
                    interface: this.interfaceName,
                    method: this.methodName
                });
            });
        } else {
            if (this.registerCenterHosts && this.registerCenterHosts.length > 0) {
                let list = await getDubboServiceMeta(this.registerCenterType, this.registerCenterHosts, this.interfaceName);
                if (list && list.length === 0) {
                    this.exact = false;
                    return
                }
                this.exact && list.forEach(item => {
                    let queryObj = querystring.parse(item.query)
                    if (queryObj.version === this.version && queryObj.group === this.group) {

                        // 灰度场景校验，新版本的接口拥有新的函数
                        let methods = queryObj.methods.split(',');
                        if (this.methodName) {
                            if (methods.indexOf(this.methodName) !== -1) {
                                this.metas.push({
                                    host: item.hostname,
                                    port: item.port,
                                    dubboVersion: queryObj.dubbo,   // dubbo框架版本
                                    version: this.version,
                                    group: this.group,
                                    token: (this.token === true || this.token === 'true') ? queryObj.token : this.token,
                                    timeout: this.timeout,
                                    interface: this.interfaceName,
                                    method: this.methodName
                                })
                            }
                        } else {
                            this.metas.push({
                                host: item.hostname,
                                port: item.port,
                                dubboVersion: queryObj.dubbo,   // dubbo框架版本
                                version: this.version,
                                group: this.group,
                                token: (this.token === true || this.token === 'true') ? queryObj.token : this.token,
                                timeout: this.timeout,
                                interface: this.interfaceName
                            })
                        }
                    }
                });
            }
        }
        this.exact = this.metas.length > 0
        if (this.exact) {
            this.createDubboSocket();
        }
    }

    /**
     * 初始化调度池
     * 创建socket
     * 每个调度器可以创建多个socket，以保障高可用，高吞吐的模式：
     */
    createDubboSocket() {
        this.metas.forEach(item => {
            let dp = getDispatcher(item.host, item.port);
            if (!dp) {
                dp = new SocketDispatcher();
                for (let i = 0; i < MAX_SOCKET_QUEUE_SIZE; i++) {
                    dp.insert(new Socket(item.port, item.host, this.registerCenterId, this.interfaceName));
                }
                addDispatcher(item.host, item.port, dp);
            }
        })
    }

    /**
     * 探活处理，重新初始化
     * 当dubboService下线后，socket会触发close事件，进而给服务打标记，等待探活。
     */
    async checkAlive() {
        try {
            let signNum = await officeSign(this.registerCenterId, this.interfaceName);
            if (signNum && signNum > 2) {
                if (this.registerCenterHosts && this.registerCenterHosts.length > 0) {
                    let metas = await getDubboServiceMetaByRegisterCenter(this.interfaceName, this.registerCenterHosts, this.registerCenterType);
                    if (metas && metas.length > 0) {
                        let registerCenterId = this.registerCenterHosts.join(',');
                        await cache.setCache(keyDubboServiceMeta(registerCenterId, this.interfaceName), metas);
                    }
                }
            }
            await clearSign(this.registerCenterId, this.interfaceName);
        } catch (e) {
            logInfo('checkDubboServiceAlive', `${this.registerCenterId}_${this.interfaceName}`, 'failed', e.toString());
        }
        await this.init();
    }

    /**
     * 重试函数，用于探活
     * @param fn：函数
     * @param args：参数
     * @param retriesMax：最高重试次数
     * @param interval：重试之间的间隔时间
     * @returns {Promise<*>}
     */
    async retry(fn, args = [], retriesMax = 2, interval = 200) {
        let self = this;
        const onAttemptFail = async () => {
            await new Promise(r => setTimeout(r, interval));
        };

        for (let i = 0; i < retriesMax; i++) {
            try {
                return await fn.apply(null, args);
            } catch (error) {
                if (retriesMax === i + 1 || !error.host) {
                    throw error;
                }
                delDispatcher(error.host, error.port);
                await self.checkAlive();
                logInfo('getSocket retry probe activity', `${error.host}:${error.port}`, 'async', error)
                await onAttemptFail();
            }
        }
    }

    /**
     * 请求，需要针对DubboService做探活处理
     * @param requestBody
     * @param methodName: 备选项，如果上文的dubboConfig没填写methodName，则在调用时传入
     * @returns {Promise<unknown>}
     */
    request(requestBody, methodName = "") {
        if (!this.exact) {
            throw new Error('not available dubbo service meta，please check registerCenter,interface,method,version,group');
        }
        let attach = null;
        let dp = null;

        /**
         * 获取socket的行为，为后续提供主动探活动作，便于二次重试，
         * @returns {Promise<unknown>}
         */
        let getSocket = () => {
            // TODO 此处决定是负载均衡，权重，还是随机算法，先随机吧。。
            let metasIndex = Math.floor(Math.random() * this.metas.length);

            attach = Object.assign({}, this.metas[metasIndex], {params: this.buildMessage(requestBody)});
            if (!attach.method) {
                if (methodName) {
                    attach.method = methodName;
                } else {
                    throw new Error('dubboService methodName is null');
                }
            }
            dp = getDispatcher(attach.host, attach.port);

            // 判断dp的可用性
            if (!dp) {
                let error = new Error('no available socket dispatcher');
                error.host = attach.host;
                error.port = attach.port;
                throw error;
            }

            return new Promise((resolve, reject) => {
                dp.gain(async (err, socket) => {
                    if (err) {
                        err.host = attach.host;
                        err.port = attach.port;
                        reject(err);
                    } else {
                        resolve(socket);
                    }
                });
            });
        }
        return new Promise((resolve, reject) => {
            this.retry(getSocket).then(socket => {
                socket.invoke({attach, resolve, reject}, err => {
                    if (err) {
                        reject(err);
                    }
                    dp.release(socket);
                    if (socket.isConnect === false) {
                        dp.purge(socket);
                    }
                });
            }).catch(e => {
                reject(e)
            })
        });
    }

    /**
     * 构造dubbo报文，多参数涉及排序的问题，特别注意
     * @param requestBody：http请求的报文一定是key-value，key：对应目标方法接收参数的全类名，value：参数的值
     */
    buildMessage(requestBody) {
        let param = [], result = []
        if (requestBody) {
            for (let k in requestBody) {
                param.push({k: k, v: requestBody[k]})
            }
        }
        /**
         * 多参数的调用，必须得排序，
         * 多参数强制key为：1:java.lang.String，2:java.lang.Integer
         */
        param.length > 0 && param.sort((before, after) => {
            if (before.k < after.k) {
                return -1
            } else {
                return 1
            }
        }).forEach(item => {
            let className = '';
            let a = item.k.split(':');
            if (a.length > 1) {
                className = a[a.length - 1]
            } else {
                className = a[0]
            }
            result.push(jsTojava(className, item.v))
        })
        return result
    }
}


/**
 * socket的调度器
 */
class SocketDispatcher {

    constructor() {
        this.queue = [];    // 正常socket队列
        this.waitingTasks = []; // 任务队列，依次阻塞
        this.busyQueue = [];    // 繁忙队列：socket
    }

    insert(socket) {
        this.queue.push(socket);
    }

    purge(socket) {
        removeByArr(this.queue, socket);
        removeByArr(this.busyQueue, socket);
    }

    gain(cb) {
        let socket = null;

        if (!this.queue.length && !this.busyQueue.length) {
            return cb(new ConnectionPoolError(EXCEPTIONS.NO_AVAILABLE_SOCKET));
        }
        if (this.queue.length) {
            socket = this.queue.shift();
            if (socket.isConnect === false) {
                this.purge(socket);
                return this.gain(cb);   // 递归
            }
            this.busyQueue.push(socket);
            cb(null, socket);
        } else {
            this.waitingTasks.push(cb);
        }
    }

    release(socket) {
        removeByArr(this.busyQueue, socket);
        this.queue.push(socket);
        if (this.waitingTasks.length) {
            this.gain(this.waitingTasks.shift());   // 依次执行剩余的任务
        }
    }
}

/**
 * dubbo socket的专属class
 */
class Socket {

    constructor(port, host, registerId, interfaceName) {
        this.port = port;
        this.host = host;
        this.registerId = registerId;
        this.interfaceName = interfaceName;
        this.init()
    }

    init() {
        this.transmiting = false;   // 数据传输态
        this.error = null;
        this.isConnect = false;

        this.heartBeatLock = false; // 心跳状态
        this.heartBeatInter = null; // 心跳起搏器

        this.resolve = null;
        this.reject = null;
        this.cb = null;

        this.chunks = [];
        this.bl = HEADER_LENGTH;

        this.socket = net.connect(this.port, this.host);
        this.socket.on('timeout', this.onTimeout.bind(this));
        this.socket.on('connect', this.onConnect.bind(this));
        this.socket.on('data', this.onData.bind(this));
        this.socket.on('error', this.onError.bind(this));
        this.socket.on('close', this.onClose.bind(this));
    }

    onTimeout() {
        if (this.reject) {
            this.reject(`${this.host}:${this.port} dubbo socket timeout`)
        }
        this.socket.end();
    }

    onConnect() {
        console.log('create socket:' + this.host + ":" + this.port)
        this.isConnect = true;
        /**
         * 为什么要心跳探测，socket默认的timeout为60秒，没有write的话会自动close，其实close也不要紧，上文有重试重连机制
         * 心跳探测的间隔为20秒吧，也不要太短。。。
         */
        this.heartBeatInter = setInterval(() => {
            if (!this.heartBeatLock) {
                this.socket.write(Buffer.from([...PROCESS_HEAD_TEMPLATE.MAGIC, ...PROCESS_HEAD_TEMPLATE.REQ_WAY_EVENT_SERIALIZATION_ID.HEARTBEAT,
                    ...PROCESS_HEAD_TEMPLATE.STATUS, ...PROCESS_HEAD_TEMPLATE.RPC_REQUEST_ID, ...HEARTBEAT_DATA.LENGTH, ...HEARTBEAT_DATA.DATA]));
            }
        }, 20000)
    }

    onData(data) {
        if (!this.chunks.length) {
            this.bl += data.readInt32BE(12);
        }
        this.chunks.push(data);
        let heap = Buffer.concat(this.chunks);
        if (heap.length === this.bl) {
            this.bl = HEADER_LENGTH;   // 请求头长度
            this.chunks = [];
            this.deSerialize(heap)
        }
    }

    /**
     * 反序列化，判断正常的服务响应，如果不是心跳活动事件，就解码
     * @param heap
     */
    deSerialize(heap) {
        if (!((heap[2] & FLAG_EVENT) !== 0)) {
            DubboDecode.do(heap, (err, result) => {
                this.transmiting = false;
                this.heartBeatLock = false; // 一次完整的数据交换结束，恢复心跳探测

                err ? this.reject(err) : this.resolve(result);
                this.resolve = null;
                this.reject = null;
                this.cb(null, true);
            })
        }
    }

    onError(err) {
        console.log('create socket fail:' + this.host + ':' + this.port + ', error:' + err.toString())
        this.error = err;
        if (this.cb) {
            this.cb(err);
        }
        if (this.reject) {
            switch (err.code) {
                case "EADDRINUSE":
                    this.reject("Address already in use");
                    break;
                case "ECONNREFUSED":
                    this.reject("Connection refused");
                    break;
                case "ECONNRESET":
                    this.destroy("Connection reset by peer");
                    break;
                case "EPIPE":
                    this.destroy("Broken pipe");
                    break;
                case "ETIMEDOUT":
                    this.reject("Operation timed out");
                    break;
            }
        }
    }

    /**
     * socket关闭的话，表示dubbo服务端主动下线。需要打一个标记，incr递增，
     */
    onClose() {
        console.log('socket has close:' + this.host + ':' + this.port)
        this.destroy('socket has closed');
        officeSign(this.registerId, this.interfaceName);
    }

    destroy(msg) {
        this.isConnect = false;
        this.reject && this.reject(msg);
        clearInterval(this.heartBeatInter);
        this.socket.destroy();
    }

    /**
     * 调用，发送报文
     * @param attach
     * @param resolve
     * @param reject
     * @param cb
     */
    invoke({attach, resolve, reject}, cb) {
        this.resolve = resolve;
        this.reject = reject;
        this.cb = cb;

        try {
            this.transmiting = true;
            this.heartBeatLock = true;  // 发送报文时停止心跳探测
            let buffer = new DubboEncode(attach).message();
            this.socket.write(buffer);
        } catch (err) {
            this.transmiting = false;
            this.heartBeatLock = false;  // 发送报文异常，恢复心跳探测
            this.cb(err, false);
        }
    }
}

/**
 * dubbo报文序列化的专属class
 * 缺省协议，使用基于netty3.2.5+hessian3.2.1交互
 * 序列化：Hessian 二进制序列化，
 * 字节流的处理：com.alibaba.dubbo.remoting.exchange.codec.ExchangeCodec，包含了对request请求的编解码，response响应的编解码。
 */
class DubboEncode {

    /**
     * @param option：包含报文相关的所有属性
     */
    constructor(option) {
        this.dubboVersion = option.dubboVersion ? option.dubboVersion : '2.5.3';  // dubbo框架版本号
        this.interface = option.interface;
        this.version = option.version;
        this.group = option.group;
        this.timeout = option.timeout ? option.timeout : 3000;  // dubbo方法调用的超时设定
        this.token = option.token;
        this.method = option.method;
        this.params = option.params
    }

    /**
     * 完整的报文信息
     */
    message() {
        let body = this.body();
        if (body.length > DUBBO_MESSAGE_MAX_LEN) {
            throw new Error(`Data length too large: ${body.length}, maximum payload: ${DUBBO_MESSAGE_MAX_LEN}`)
        }
        let head = this.head(body.length);

        return Buffer.concat([head, body])
    }

    /**
     * 组装body，除了写入正常请求参数之外，还有接口的相关设置，
     * write还是不带类型了，否则参数为基本数据类型时，会报编码错误
     */
    body() {
        let body = new Encoder();
        body.writeString(this.dubboVersion);
        body.writeString(this.interface);
        body.writeString(this.version);
        body.writeString(this.method);

        if (this.dubboVersion.startsWith('2.8')) {
            body.writeInt(-1); // TODO for dubbox 2.8.X，需要用dubbox做个测试
        }
        body.writeString(this.paramsType());

        if (this.params && this.params.length) {
            this.params.forEach(arg => {
                body.write(arg)
            })
        }
        body.write(this.attachments());
        return body.byteBuffer._bytes.slice(0, body.byteBuffer._offset);
    }

    /**
     * 根据协议标准，headers中写入8个字节的RPC请求ID，4个字节的消息文本长度
     * @param len
     */
    head(len) {
        let process_head_template = [...PROCESS_HEAD_TEMPLATE.MAGIC, ...PROCESS_HEAD_TEMPLATE.REQ_WAY_EVENT_SERIALIZATION_ID.REQ_RES,
            ...PROCESS_HEAD_TEMPLATE.STATUS, ...PROCESS_HEAD_TEMPLATE.RPC_REQUEST_ID, ...PROCESS_HEAD_TEMPLATE.DATA_LENGTH];
        let head = Buffer.from(process_head_template);
        head.writeBigUInt64LE(BigInt(requestId()), 4)
        head.writeInt32BE(len, 12);
        return head;
    }

    /**
     * 参数类型设定，
     */
    paramsType() {
        if (!(this.params && this.params.length)) {
            return '';
        }
        let typeRef = {boolean: 'Z', int: 'I', short: 'S', long: 'J', double: 'D', float: 'F'}
        let parameterTypes = "";
        let type;

        for (let i = 0, l = this.params.length; i < l; i++) {
            type = this.params[i]["$class"];

            if (type.charAt(0) === "[") {
                parameterTypes += ~type.indexOf(".") ? "[L" + type.slice(1).replace(/\./gi, "/") + ";" : "[" + typeRef[type.slice(1)];
            } else {
                parameterTypes += type && ~type.indexOf(".") ? "L" + type.replace(/\./gi, "/") + ";" : typeRef[type];
            }
        }
        return parameterTypes;
    }

    /**
     * 附件信息（隐含参数）：接口全类名，超时设定，版本号，分组名，token
     */
    attachments() {
        let implicitArgs = {
            interface: this.interface,
            path: this.interface,
            timeout: this.timeout,
        }
        this.version && (implicitArgs.verison = this.version);
        this.group && (implicitArgs.group = this.group);
        this.token && (implicitArgs.token = this.token);
        return {$class: 'java.util.HashMap', $: implicitArgs};
    }
}

/**
 * dubbo响应报文的解码配置
 */
let DubboDecode = {

    Response: {
        OK: 20,
        CLIENT_TIMEOUT: 30,
        SERVER_TIMEOUT: 31,
        BAD_REQUEST: 40,
        BAD_RESPONSE: 50,
        SERVICE_NOT_FOUND: 60,
        SERVICE_ERROR: 70,
        SERVER_ERROR: 80,
        CLIENT_ERROR: 90
    },
    RESPONSE_WITH_EXCEPTION: 0,
    RESPONSE_VALUE: 1,
    RESPONSE_NULL_VALUE: 2,

    /**
     * 解码
     * @param heap
     * @param cb
     */
    do: function (heap, cb) {
        const result = new decoder(heap.slice(16, heap.length));
        if (heap[3] !== this.Response.OK) {
            return cb(result.readString());
        }
        try {
            const flag = result.readInt();

            switch (flag) {
                case this.RESPONSE_NULL_VALUE:
                    cb(null, null);
                    break;
                case this.RESPONSE_VALUE:
                    cb(null, result.read());
                    break;
                case this.RESPONSE_WITH_EXCEPTION:
                    let exception = result.read();
                    !(exception instanceof Error) && (exception = new Error(exception));
                    cb(exception);
                    break;
                default:
                    cb(new Error(`Unknown result flag, expect '0' '1' '2', get ${flag}`));
            }

        } catch (err) {
            cb(err);
        }
    }
}

/**
 * 连接池错误的专属class
 */
class ConnectionPoolError extends Error {
    constructor(key, code, message, name) {
        super();
        const exception = EXCEPTIONS_MAP[key];

        if (!exception) {
            this.name = "Unknown error";
        } else {
            this.code = code || exception.code;
            this.message = message || exception.message;
            this.name = "ConnectionPoolError";
        }
    }
}

const EXCEPTIONS = {
    NO_AVAILABLE_SOCKET: "NO_AVAILABLE_SOCKET"
};

const EXCEPTIONS_MAP = {
    NO_AVAILABLE_SOCKET: {code: "100", message: "no available socket"}
};

/**
 * 从数组中移除
 * @param arr
 * @param item
 */
let removeByArr = function (arr, item) {
    const index = arr.indexOf(item);
    if (index !== -1) {
        arr.splice(index, 1);
    }
}

/**
 * 获取元数据
 * @param registerCenterType
 * @param interfaceName
 */
async function getDubboServiceMeta(registerCenterType, registerCenterHosts, interfaceName) {
    let registerId = registerCenterHosts.join(',')
    let key = keyDubboServiceMeta(registerId, interfaceName)
    try {
        let list = await cache.getCache(key);
        if (list) {
            return list;
        }
        let metas = await getDubboServiceMetaByRegisterCenter(interfaceName, registerCenterHosts, registerCenterType);
        if (metas || metas.length > 0) {
            await cache.setCache(key, metas);
        }
        return metas;
    } catch (e) {
        logInfo('getDubboServiceMeta', key, 'failed', e.toString());
    }
}

/**
 * 从注册中心获取元数据
 * @param interfaceName
 * @param address
 * @param type
 * @returns {Promise<Array     >}
 */
function getDubboServiceMetaByRegisterCenter(interfaceName, address = [], type = 'zookeeper') {
    return new Promise((resolve, reject) => {
        if (type === 'zookeeper') {
            let path = `/dubbo/${interfaceName}/providers`
            try {
                let zk = zookeeper.createClient(address.join(','));
                zk.connect();
                zk.on("connected", function () {
                    zk.getChildren(path, function (error, children, stat) {
                        try {
                            zk.close()
                            if (error || !children) {
                                reject(error || new Error('get DubboServiceMeta is null'))
                            }
                            let list = [];
                            children.forEach(item => {
                                list.push(URL.parse(decodeURIComponent(item)));
                            })
                            resolve(list);
                        } catch (err) {
                            logInfo('getDubboServiceMetaByRegisterCenter', keyDubboServiceMeta(address.join(','), interfaceName), 'failed', err.toString());
                            reject(err);
                        }
                    })
                })
            } catch (e) {
                logInfo('getDubboServiceMetaByRegisterCenter', keyDubboServiceMeta(address.join(','), interfaceName), 'failed', e.toString());
                reject(e);
            }
        }
        // 其他注册中心，可依次去自行适配nacos,consul,eureka……
    })
}

/**
 * 采集日志
 * @param args
 */
function logInfo(...args) {
    console.dir(args)
}

/**
 * 请求ID
 * @returns {string}
 */
function requestId() {
    let s = [];
    for (let i = 0; i < STATIC_BASE_DATA.length; i++) {
        s[i] = STATIC_BASE_DATA.substr(Math.floor(Math.random() * STATIC_BASE_DATA.length), 1);
    }
    return s.join('')
}

/**
 * 获取socket调度器
 * @param ip
 * @param port
 */
function getDispatcher(ip, port) {
    if (!process['dubboServiceDispatcherPool']) {
        process['dubboServiceDispatcherPool'] = {};
    }
    return process['dubboServiceDispatcherPool'][`${ip}/${port}`];
}

/**
 * 添加socket调度器
 * @param ip
 * @param port
 * @param dp
 */
function addDispatcher(ip, port, dp) {
    if (!process['dubboServiceDispatcherPool']) {
        process['dubboServiceDispatcherPool'] = {};
    }
    process['dubboServiceDispatcherPool'][`${ip}/${port}`] = dp;
}

/**
 * 移除socket调度器
 * @param ip
 * @param port
 * @param dp
 */
function delDispatcher(ip, port) {
    delete process['dubboServiceDispatcherPool'][`${ip}/${port}`];
}

/**
 * 清除标记，将标记置0
 * @param registerCenterId
 * @param interfaceName
 * @returns {Promise<void>}
 */
async function clearSign(signId, interfaceName) {
    try {
        await cache.setCache(keyOffice(`${signId}_${interfaceName}`), 0);
    } catch (e) {
        logInfo('clearSign', `${signId}_${interfaceName}`, 'failed', e.toString());
    }
}

/**
 * dubboService下线时打个标记，+1
 * @param signId
 * @param interfaceName
 * @returns {Promise<*>}
 */
async function officeSign(signId, interfaceName) {
    try {
        let result = await cache.increase(keyOffice(`${signId}_${interfaceName}`));
        return result;
    } catch (e) {
        logInfo('officeSign', `${signId}_${interfaceName}`, 'failed', e.toString());
    }
    return null;
}

/**
 * 标记dubboService下线的key，
 */
function keyOffice(suffix) {
    return `office:${suffix}`;
}

/**
 * 元数据的key：id/interfaceName
 */
function keyDubboServiceMeta(id, interfaceName) {
    return `${id}_${interfaceName}`
}

module.exports = Dubbo