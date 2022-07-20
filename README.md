标题：http请求dubbo服务的最终解决方案

引言：所有的rpc协议遵守着一个万变不离其宗的定律：调用方与服务提供方有一套约定的报文解析格式

> 注：文章有点长，涉及全量代码的解释，是可以直接拿走投入使用的那种，还请耐心看完。

# 1、协议简介

> 1、什么是协议？
>
> 协议的本质就是有固定格式的数据与二进制数据之间的转换，因为只有二进制才能在网络中传输。数据从一个实体传输到另一个实体，必须是以“电平信号”或者“光信号”进行表达传输。eg：高电平1低电平0。
>
> 2、什么是RPC协议？
>
> 基于底层TCP/UDP协议之上，针对固定格式数据做一个强约束的概念，规定客户端与服务端只能收发某种结构定好的数据。
>
> 3、什么是Dubbo协议？
>
> 基于RPC概念之上的实际应用，本质就是服务消费者与服务提供者之间是怎么通信的，即如何识别对方的数据。可以概括两点：1、一方在读另一方传输的数据时，**何时结束（协议标准）**；2、结束之后，如何把读到的二进制数据转为对象的形式（序列化）；

## 1.1、RPC协议

1、初衷：让调用远程函数像调用本地函数一样简单无差别，相对http协议，它主动屏蔽了地址，URL等一些网络请求信息；

2、彻底隐藏了网络传输的细节，调用方只需要按照约定好的格式去组装对象，然后传参即可；

3、虽然可以基于任何网络通信协议，还是以tcp为主，原因不外乎需要保障请求的可靠性和集群模式下高可用的活性探测，健康检查；

4、虽然是调用函数，仍旧涉及通信系统，另一台计算机，另一个进程，需要手动处理网络问题引起的异常。

## 1.2、dubbo协议

dubbo框架定义了私有化的RPC协议，请求和响应的具体内容都有一套标准，该文实现的逻辑，就是按照这个标准将http请求报文，组装成dubbo报文发送给dubbo服务的。

### 1.2.1、何时结束（协议标准）

tcp是流式传输协议，数据包之间无缝拼接，不会使用特殊分割字符，所以应用层协议都需要制定一套标准用来解析tcp的数据包。

> 例如http是文本格式的协议，按照字符串文本的方式处理，以换行+行编排的方式解析，分为四个部分（四行），第一行是请求行，第二行是请求headers，第三行空行，第四行请求body，响应也是一样，每行之间又有着其他格式解析。
>
> 请求行包括三部分，每一部分之间用空格隔开，分别为method，url，http协议版本号；
>
> 请求headers先通过空格来分割自身，然后将分割后的每个元素再以 ：分割成key-value结构；
>
> 请求body：在请求/响应headers中会标注body的内容格式：content-type，方便对方解析处理。

dubbo也一样，服务提供者在读服务消费者传递的报文时，必须要知道何时结束？

定义协议标准的时刻到了！

这种实现逻辑当下有三种：

1、定长协议；（缺点：不灵活，局限性太大，内容很难固定长度）

2、特殊结束符；（缺点：内容不能包含特殊结束符，会影响序列化）

3、变长协议：由两部分组成（1、内容长度：存储内容长度的部分是固定的，2、内容本身：非固定长度，由前面的内容长度来标明结束位），绝大多数协议采用这种实现逻辑。

**如下图所示：**

![dubbo协议标准](https://user-images.githubusercontent.com/37284463/179986753-9abd9d4e-5363-47f3-9aa8-a0d08a9e49d9.png)

简单描述：一行是4个字节，32位。一直到96位那里，即第16个字节之前，都属于headers内容，往后的才是body。

**Magic- Magic Hign & Magic Low**:占16bits，魔法数位，标识了协议版本号；

**Req/Res：**占1bit，数据包类型，标识是请求还是响应，1为request，0为response

**2Way：**占1bit，调用方式（是否期待有返回值），0为单向调用，1位双向调用，仅在Req/Res为1时才有用，比如通过调用去操作服务停机发送readonly数据时，就不需要双向调用了

**Event：**占1bit，事件标识，0表示数据包为请求&响应包，1表示数据包为心跳包，作用于tcp会话保持时用到；

**Serialization ID：**占5bit，标识序列化类型，默认为hessian2，置0就行，或者用hessian2的编码2来表示，全量看：

- 2位hessian2
- 3位JavaSerialization
- 4为CompactedJavaSerialization
- 6为FastJsonSerialization
- 7为NativJavaSerialization
- 8为KryoSerialization
- 9为FstSerialization

**Status：**占8bit，表示状态，仅在 Req/Res 为0（response）时有用，用于标识响应的状态；

- 20 - OK
- 30 - CLIENT_TIMEOUT
- 31 - SERVER_TIMEOUT
- 40 - BAD_REQUEST
- 50 - BAD_RESPONSE
- 60 - SERVICE_NOT_FOUND
- 70 - SERVICE_ERROR
- 80 - SERVER_ERROR
- 90 - CLIENT_ERROR
- 100 - SERVER_THREADPOOL_EXHAUSTED_ERROR

**Request ID：**占64bit，标识唯一请求，类型为long，用8个字节来存储RPC请求的唯一id，用来将请求和响应做关联；

**Data Length：**占32bit，用4个字节来存储消息体的内容长度，按字节技术，int类型。

**Variable length Part：**可变长度内容，被指定的序列化类型（由Serialization ID标识）序列化后，每个部分都是一个byte[]或者byte，如果是请求包（ Req/Res = 1），则每个部分依次为：

- dubbo version
- service name
- service version
- method name
- method parameter types
- method arguments
- attachments

如果是响应包（Req/Res = 0），则每个部分依次为：

返回值类型（byte）标识从服务器端返回的值类型

- 返回空值：RESPONSE_NULL_VALUE 2
- 正常响应值： RESPONSE_VALUE 1
- 异常：RESPONSE_WITH_EXCEPTION 0

返回值：从服务端返回的响应bytes

> 特别说明：对于Variable length Part部分，dubbo框架使用json序列化时，会在每部分内容间额外增添换行符作为分割，如果涉及协议转换开发需求时，还需要为每个part后新增换行符。（下文代码展示，默认传输协议为官方默认的dubbo，默认序列化协议为官方默认的hessian2）

如上所述：可以看出，dubbo协议在设计上是很紧凑的，肯定是为提升传输性能，但没有预留扩展字段，升级的过程必须是客户端与服务端统一进行，无法灰度。

### 1.2.2、传输序列化

上文的协议标准中已经提到序列化的几种方式，其实就是对象数据与二进制之间的转换。

**hessian2：**dubbo默认的传输序列化方式，一种跨语言的高效二进制序列化方式，兼容性好。

> 虽说Dubbo Rpc完全是一种java to java的远程调用，优秀的hessian2从跨语言的角度出发，明显为我们保留的anything to java的能力，这就成了本文的切入点。

至于其他的JavaSerialization（JDK自带），FastJsonSerialization（json库提供）……性能是一个不如一个，保障请求&响应的高效，还是推荐使用官方默认的序列化方式。

> 随着技术发展，各种高效的序列化方式层出不穷，不断刷新着性能的上限，最典型的包括：专门针对java的Kryo，FST……跨语言的Protostuff，ProtoBuf……可以自己测试玩一下，采用不一样的序列化方式搭建dubbo服务provider和consumer。

到此，协议标准和序列化方式都已经浮出水面，意味着我们可以按照标准构造报文，序列化后发送dubbo请求了，但是不急，还需要引入第二个核心：注册中心。

# 2、注册中心

## 2.1、解决方案

初期，consumer会直连provider，互联网技术爆炸式的发展，从单点到集群，对资源的要求也越来越高，直连的模式无法对面各种场景，比如集群模式下的负载均衡，权重轮询，健康检查，白名单……，如果consumer在调用provider的时候，去逐一实现这些概念的话，维护成本太高，且没有拓展空间可言，注册中心的出现，成了服务高可用的最终解决方案。

provider将自己当作服务实例依次注册到注册中心，consumer根据约定好的标识（eg：instanceId）从注册中心获取可用的节点后，先缓存到本地，继续后面的服务调用，如果期间有provider故障下线的话，注册中心需要感知，并且推送给consumer新的可用节点，更新本地缓存。

**照此来看，注册中心必须实现以下功能：**

1. 注册接口：provider通过此接口完成服务注册，更心注册服务列表；
2. 注销接口：通过此接口provider可以主动下线，更心注册服务列表；
3. 健康检查机制：provider间隔发送心跳包，完成服务状态上报；
4. 服务查询：consumer通过此接口查询服务列表信息；

**选择性可实现：**

1. 白名单机制：生产环境隔离使用，强约束consumer的来源；
2. 服务信息编辑：编排元数据信息，负载权重；
3. …………

依据上述功能，我们也可以自己实现一个简单的注册中心，感兴趣的可以试试。至于注册中心集群的高可用方案，CAP理论……不在本文的探讨范围之内，直接跳过。

## 2.2、使用范例

此处尝试使用**zookeeper**和**nacos**来做测试，分别将服务注册到其中。

采用springBoot快速创建一个dubbo服务提供者

pom.xml添加如下依赖：

```xml
		<!-- dubbo依赖 -->
		<dependency>
			<groupId>com.alibaba.spring.boot</groupId>
			<artifactId>dubbo-spring-boot-starter</artifactId>
			<version>${dubbo.version}</version>
		</dependency>

		<!-- 引入zookeeper的依赖，zookeeper/nacos 二选一 -->
		<dependency>
			<groupId>com.101tec</groupId>
			<artifactId>zkclient</artifactId>
			<version>${zk.version}</version>
		</dependency>

		<!-- Dubbo Nacos registry dependency -->
		<dependency>
			<groupId>com.alibaba</groupId>
			<artifactId>dubbo-registry-nacos</artifactId>
			<version>${nacos.version}</version>
		</dependency>
```

application.properties

```properties
#配置端口
server.port=9091

# 别名
spring.dubbo.application.name=rio-dubbo-provider

# 注册中心，zk 和 nacos切换
#spring.dubbo.application.registry=zookeeper://127.0.0.1:2181
spring.dubbo.application.registry=nacos://127.0.0.1:8848

# 数据协议,默认就是dubbo（官方推荐）,可配置rmi（JDK提供）,配置hessian需要单独加配置代码
spring.dubbo.protocol.name=dubbo

## dubbo端口号
spring.dubbo.protocol.port=20881

# 发布接口的包路径
spring.dubbo.scan=vip.wangjc.rio.provider.service
```

注册的服务添加如下注解：@Service是alibaba.dubbo框架的，@Component是Spring框架的

```java
@Service(version = "1.0.0", group = "rio", token = "123456")
@Component
```

完整代码需要的话，可参考：https://github.com/994625905/rio_dubbo.git，或者也可以用自己现有的dubb测试服务。

### 2.2.1、zookeeper

zk采用树形结构来存储数据，跟文件系统路径香类似的节点，可以向节点set/get数据。先使用zk注册中心，服务成功启动后，可以去zk中看看数据，例如，现在服务已经注册好了，通过zkCli.sh查看节点信息

```shell
[zk: localhost:2181(CONNECTED) 1] ls /
[dubbo, zookeeper]
[zk: localhost:2181(CONNECTED) 2] ls /dubbo
[vip.wangjc.rio.api.service.RioDubboService]
[zk: localhost:2181(CONNECTED) 3] ls /dubbo/vip.wangjc.rio.api.service.RioDubboService
[configurators, consumers, providers, routers]
[zk: localhost:2181(CONNECTED) 4] ls /dubbo/vip.wangjc.rio.api.service.RioDubboService/configurators
[]
[zk: localhost:2181(CONNECTED) 5] ls /dubbo/vip.wangjc.rio.api.service.RioDubboService/providers
[dubbo%3A%2F%2F10.91.79.129%3A20881%2Fvip.wangjc.rio.api.service.RioDubboService%3Fanyhost%3Dtrue%26application%3Drio-dubbo-provider%26dubbo%3D2.6.0%26generic%3Dfalse%26group%3Drio%26interface%3Dvip.wangjc.rio.api.service.RioDubboService%26methods%3DgetUser%2CgetUserByName%2CupdateUser%2CgetUserName%26pid%3D50722%26revision%3D1.0.0%26side%3Dprovider%26timestamp%3D1658215674244%26token%3D123456%26version%3D1.0.0]
```

综上，dubbo服务注册到zookeeper中的层级结构为：`/${rootPath}/${interfaceName}/${provider}`

- rootPath：根节点名称，默认是dubbo，
- interfaceName：服务全类名，保证唯一性
- provider：分类，为了区分其他可能的configurators，routers，consumers……预留扩展功能

元数据结构为被URI编码之后的数组，数组代表集群，一个实例可以注册多个服务保证高可用，且看URL解码之后的元数据信息：

> 遍历数组，先URI解码，解码之后在用url格式化处理为json对象，然后添加到新的数组，最后输出新数组：

```json
[
  {
    protocol: 'dubbo:',
    slashes: true,
    auth: null,
    host: '10.91.79.129:20881',
    port: '20881',
    hostname: '10.91.79.129',
    hash: null,
    search: '?anyhost=true&application=rio-dubbo-provider&dubbo=2.6.0&generic=false&group=rio&interface=vip.wangjc.rio.api.service.RioDubboService&methods=getUser,getUserByName,updateUser,getUserName&pid=50722&revision=1.0.0&side=provider&timestamp=1658215674244&token=123456&version=1.0.0',
    query: 'anyhost=true&application=rio-dubbo-provider&dubbo=2.6.0&generic=false&group=rio&interface=vip.wangjc.rio.api.service.RioDubboService&methods=getUser,getUserByName,updateUser,getUserName&pid=50722&revision=1.0.0&side=provider&timestamp=1658215674244&token=123456&version=1.0.0',
    pathname: '/vip.wangjc.rio.api.service.RioDubboService',
    path: '/vip.wangjc.rio.api.service.RioDubboService?anyhost=true&application=rio-dubbo-provider&dubbo=2.6.0&generic=false&group=rio&interface=vip.wangjc.rio.api.service.RioDubboService&methods=getUser,getUserByName,updateUser,getUserName&pid=50722&revision=1.0.0&side=provider&timestamp=1658215674244&token=123456&version=1.0.0',
    href: 'dubbo://10.91.79.129:20881/vip.wangjc.rio.api.service.RioDubboService?anyhost=true&application=rio-dubbo-provider&dubbo=2.6.0&generic=false&group=rio&interface=vip.wangjc.rio.api.service.RioDubboService&methods=getUser,getUserByName,updateUser,getUserName&pid=50722&revision=1.0.0&side=provider&timestamp=1658215674244&token=123456&version=1.0.0'
  }
]
```

结构清晰，不言而喻，上文协议标准中**Variable length Part**所需的基础内容，都可以拿到了，如：interface，method，version，token……只是还需对"href"内容做进一步处理。

### 2.2.2、nacos

传送门看这里：https://nacos.io/zh-cn/docs/what-is-nacos.html

将dubbo测试服务的配置文件`spring.dubbo.application.registry`改为nacos地址，然后重新启动服务。

通过nacos的可视化控制台可以发现，dubbo服务注册到nacos的服务名称：`providers:${interfaceName}:${version}:${group}`

我们也可以通过tcpdump抓包发现服务注册时传递了哪些参数：

```shell
# 如下是服务注册时的请求&响应信息

POST /nacos/v1/ns/instance?groupName=DEFAULT_GROUP&metadata=%7B%22side%22%3A%22provider%22%2C%22methods%22%3A%22getUser%2CupdateUser%2CgetUserByName%2CgetUserName%22%2C%22dubbo%22%3A%222.6.0%22%2C%22pid%22%3A%2289811%22%2C%22interface%22%3A%22vip.wangjc.rio.api.service.RioDubboService%22%2C%22version%22%3A%221.0.0%22%2C%22generic%22%3A%22false%22%2C%22revision%22%3A%221.0.0%22%2C%22token%22%3A%22123456%22%2C%22protocol%22%3A%22dubbo%22%2C%22application%22%3A%22rio-dubbo-provider%22%2C%22category%22%3A%22providers%22%2C%22anyhost%22%3A%22true%22%2C%22group%22%3A%22rio%22%2C%22timestamp%22%3A%221658231753356%22%7D&namespaceId=public&port=20881&enable=true&healthy=true&ip=10.91.79.129&weight=1.0&ephemeral=true&serviceName=DEFAULT_GROUP%40%40providers%3Avip.wangjc.rio.api.service.RioDubboService%3A1.0.0%3Ario&encoding=UTF-8 HTTP/1.1
Client-Version: Nacos-Java-Client:v1.1.1
User-Agent: Nacos-Java-Client:v1.1.1
Accept-Encoding: gzip,deflate,sdch
RequestId: ff28e224-d2ec-4dd0-be1f-fd92a93f983d
Request-Module: Naming
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Accept-Charset: UTF-8
Host: 9.135.218.88:8848
Accept: text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2
Connection: keep-alive
Content-Length: 804

groupName=DEFAULT_GROUP&metadata=%7B%22side%22%3A%22provider%22%2C%22methods%22%3A%22getUser%2CupdateUser%2CgetUserByName%2CgetUserName%22%2C%22dubbo%22%3A%222.6.0%22%2C%22pid%22%3A%2289811%22%2C%22interface%22%3A%22vip.wangjc.rio.api.service.RioDubboService%22%2C%22version%22%3A%221.0.0%22%2C%22generic%22%3A%22false%22%2C%22revision%22%3A%221.0.0%22%2C%22token%22%3A%22123456%22%2C%22protocol%22%3A%22dubbo%22%2C%22application%22%3A%22rio-dubbo-provider%22%2C%22category%22%3A%22providers%22%2C%22anyhost%22%3A%22true%22%2C%22group%22%3A%22rio%22%2C%22timestamp%22%3A%221658231753356%22%7D&namespaceId=public&port=20881&enable=true&healthy=true&ip=10.91.79.129&weight=1.0&ephemeral=true&serviceName=DEFAULT_GROUP%40%40providers%3Avip.wangjc.rio.api.service.RioDubboService%3A1.0.0%3Ario&encoding=UTF-8

HTTP/1.1 200 
Content-Security-Policy: script-src 'self'
Content-Type: text/html;charset=UTF-8
Content-Length: 2
Date: Tue, 19 Jul 2022 11:55:53 GMT
Keep-Alive: timeout=60
Connection: keep-alive

ok
```

知道了服务注册成功的名称后，可以使用官方提供的openapi去获取服务实例列表。

```shell
[root@VM-218-88-centos ~] curl -XGET "http://127.0.0.1:8848/nacos/v1/ns/instance/list?serviceName=providers:vip.wangjc.rio.api.service.RioDubboService:1.0.0:rio"|jq 
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  1069    0  1069    0     0   580k      0 --:--:-- --:--:-- --:--:-- 1043k
{
  "name": "DEFAULT_GROUP@@providers:vip.wangjc.rio.api.service.RioDubboService:1.0.0:rio",
  "groupName": "DEFAULT_GROUP",
  "clusters": "",
  "cacheMillis": 10000,
  "hosts": [
    {
      "instanceId": "10.91.79.129#20881#DEFAULT#DEFAULT_GROUP@@providers:vip.wangjc.rio.api.service.RioDubboService:1.0.0:rio",
      "ip": "10.91.79.129",
      "port": 20881,
      "weight": 1,
      "healthy": true,
      "enabled": true,
      "ephemeral": true,
      "clusterName": "DEFAULT",
      "serviceName": "DEFAULT_GROUP@@providers:vip.wangjc.rio.api.service.RioDubboService:1.0.0:rio",
      "metadata": {
        "side": "provider",
        "methods": "getUser,updateUser,getUserByName,getUserName",
        "dubbo": "2.6.0",
        "pid": "89811",
        "interface": "vip.wangjc.rio.api.service.RioDubboService",
        "version": "1.0.0",
        "generic": "false",
        "revision": "1.0.0",
        "token": "123456",
        "protocol": "dubbo",
        "application": "rio-dubbo-provider",
        "category": "providers",
        "anyhost": "true",
        "group": "rio",
        "timestamp": "1658231753356"
      },
      "instanceHeartBeatInterval": 5000,
      "instanceHeartBeatTimeOut": 15000,
      "ipDeleteTimeout": 30000
    }
  ],
  "lastRefTime": 1658232697212,
  "checksum": "",
  "allIPs": false,
  "reachProtectionThreshold": false,
  "valid": true
}
```

hosts为数组，表示集群高可用模式，一个服务可以有多个实例，结构清晰，不言而喻，上文协议标准中**Variable length Part**所需的基础内容，都可以拿到，如：interface，method，version，token……无需二次处理。

至于实例之外的其他参数，则为nacos的功能个性化配置。

# 3、实现方案

根据上文的描述，实现逻辑就可以规划出来了，我们需要：

1. 需要服务提供方告诉我它的注册中心地址以及类型，方便定向拉取服务元数据列表；
2. 需要提供多实例下的version和group，这两者是做版本或者分组隔离，即使同一服务下不同实例的功能可能不一样，作为实例列表的筛选过滤条件（单点可能不会设置version或group，无妨，有就传，没有则忽略）；
3. 需要提供是否设置鉴权的token；
4. 需要告诉我服务提供方采用的什么通讯协议；（官方默认为dubbo）
5. 需要告诉调用的函数名称，参数类型，结构。

这其实也是dubbo标准的consumer需要的信息，该实现方案并没有新增什么附加必要项。

有了这些，我们就可以先获取服务元数据信息，然后再根据负载策略选择合适的实例建立tcp连接（或者是先依次建立tcp连接，在请求时根据负载策略具体筛选使用哪一个，本文采用的这种方式），根据配置的各项参数按照上文的协议标准组装报文，请求dubbo服务，最后解析响应报文。

实现语言任选，golang，python，c……都可以，如果是用Java来做的话，那阅读这篇文章的意义就不大了，完全可以把consumer用SpringMVC包成一个http server，根据请求的path去反射调用的方法名称就完成了。

为了跟项目产品相吻合，我们这里使用nodejs来实现，文末附git地址。

## 3.1、dubboConfig结构

如下所示，userManager抽象代表为dubbo服务的一个interface，method从请求的path中获取，即http请求的path应该表示为`http://${domain}/${userManager}/${methodName}`，userManager为了命中某一个dubbo配置，methodName为了请求该dubbo接口指定方法。

```json
{
  "userManager": {
    "registerCenterHosts": [
      "9.134.164.91:2181"
    ],
    "registerCenterType": "zookeeper",
    "interfaceName": "vip.wangjc.rio.api.service.RioDubboService",
    "version": "1.0.0",
    "group": "rio",
    "token": "true"
  }
}
```

## 3.2、搭建http server

如下代码，思路应该比较简洁，

1. 启动入口为start，先初始化dubbo配置文件，再开启http服务，监听请求；
2. 初始化dubbo，遍历dubboConfig，依次初始化后存入到dubboCache对象中；
3. 开启http服务，并监听请求事件，请求触发时，如果dubboConfig为空，就返回500；
4. 获取请求的pathname，按/分割，要求必须`/${userManager}/${methodName}`，结尾不能带/，否则依次返回500&错误信息；
5. 分别从query（url路径）和body中读取请求报文，组合到一起。（为了强兼容http请求，防止post部分参数写在了URL中）；
6. 拿到组合的报文体+methodName，根据path筛选的dubbo对象，去请求dubbo服务；
7. 做出http响应，200 & 500，正常报文 & error info

```javascript
/**
 * create by ikejcwang on 2022.03.07.
 * 注：这只是一个demo，没有适配高并发，故没有引用cluster模块，生产可以按此来改造。
 */
'use strict';
const http = require('http');
const nodeUtil = require('util');
const URL = require('url');
const Dubbo = require('./dubbo');
const settings = require('./settings').settings;
const configs = require('./settings').configs;
let dubboCache = {}

start();

/**
 * 启动入口
 */
function start() {
    initDubboConfig();
    startHttpServer();
}

/**
 * 初始化dubbo配置
 */
function initDubboConfig() {
    if (configs && Object.keys(configs).length > 0) {
        for (let key in configs) {
            dubboCache[key] = new Dubbo(configs[key]);
        }
    }
}

/**
 * 启动http服务
 */
function startHttpServer() {
    let server = http.createServer();
    server.on('request', listenRequestEvent);
    server.on('close', () => {
        console.log('http Server has Stopped At:' + port)
    });
    server.on('error', err => {
        console.log('http Server error:' + err.toString());
        setTimeout(() => {
            process.exit(1);
        }, 3000);
    });
    server.listen(settings['bindPort'], settings['bindIP'], settings['backlog'] || 8191, () => {
        console.log('Started Http Server At: ' + settings['bindIP'] + ':' + settings['bindPort'])
    })
}

/**
 * 监听request事件
 * @param request
 * @param response
 */
async function listenRequestEvent(request, response) {
    request.on('aborted', () => {
        console.error('aborted: client request aborted')
    });
    request.on('finish', () => {
        console.log('request has finished');
    })
    request.on('error', (err) => {
        console.log(`error event: ${nodeUtil.inspect(err)}`)
    })
    try {
        if (!configs || Object.keys(configs).length < 1) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end('No Dubbo Config');
            return;
        }
        let sourceUrl = URL.parse(request.url, true);
        let pathArr = sourceUrl.pathname.split('/').splice(1);
        if (pathArr.length < 2 || !pathArr[pathArr.length - 1]) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end('Unable to resolve dubboMethod from pathname');
            return;
        }

        let dubboConfigName = pathArr.splice(0, pathArr.length - 1).join('/');
        let dubboMethod = pathArr[pathArr.length - 1];
        let dubboObj = dubboCache[dubboConfigName];
        if (!dubboObj) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end(`Unable to resolve ${dubboConfigName} from config`);
            return;
        }
        let body = sourceUrl.query;
        let bodyChunk = [];
        request.on('data', chunk => {
            bodyChunk.push(chunk);
        });
        request.on('end', () => {
            if (bodyChunk.length > 0) {
                body = Object.assign(body, JSON.parse(bodyChunk.toString()));
            }
            try {
                dubboObj.request(body, dubboMethod).then(resBody => {
                    request.resBody_len = JSON.stringify(resBody).length;
                    request.duration = Date.now() - request.startTime;
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json; charset=utf-8');
                    response.end(Buffer.from(JSON.stringify(resBody)));
                }).catch(err => {
                    request.errMsg = err.toString();
                    request.duration = Date.now() - request.startTime;
                    response.statusCode = 500;
                    response.setHeader('content-type', 'text/html; charset=utf-8');
                    response.end(Buffer.from(err.toString()));
                });

            } catch (e) {
                request.errMsg = e.toString();
                response.statusCode = 500;
                response.setHeader('content-type', 'text/html; charset=utf-8');
                response.end(Buffer.from(e.toString()));
            }
        });
    } catch (e) {
        console.log(`request_error: ${nodeUtil.inspect(e)}`);
        response.statusCode = 502;
        response.end('ike httpToDubbo proxy error');
    }
}
```

## 3.3、封装Dubbo类库

**核心部分！**，代码比较长，注释信息很齐全，简单介绍描述一下：

1. 创建Dubbo对象时，传递dubboConfig配置项开始初始化，看是直连服务还是从注册中心拉取数据；
2. 判断缓存中是否有指定服务元数据列表，没有的话从注册中心中获取，并set到本地缓存（此处内置了一个简单的cache组件），防止多个dubboConfig时重复去连接注册中心；
3. 通过dubboConfig的条件筛选项过滤匹配服务列表，找出可用，挂在当前对象中；
4. 创建socket调度器，根据最大socket队列长度依次初始化socket，放到调度器的队列中，将调度器挂到进程变量上；
5. socket调度器的获取socket，设置繁忙&空闲态，请自行去看代码SocketDispatcher类；
6. socket的组装&解析报文，心跳探测，关闭时打标签……请自行去看代码Socket类；
7. 当上文收到请求，并成功调用dubbo.request时，先从进程变量获取socket调度器，然后再从调度器队列中获取可用socket，逻辑涉及：探活，重试，移除，重新初始化，继续请求……请自行去看代码request()函数；
8. 拿到可用socket后，组报文，发数据包，收数据包，解报文；

```javascript
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
const HEADER_LENGTH = 16;   // 协议标准头信息固定16个字节长度
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
```

## 3.4、自问自答

1、为什么socket调度器需要挂到进程变量上？

> 这只是个demo，生产上用的no dejs cluster 多进程机制，本地缓存是涉及进程之间通信共享的，无法将socket对象在此间传输，故此只能挂到进程变量中，相对独立；

2、中途dubbo服务端挂掉怎么办？

> request()函数中，有探活&重试机制，只要该进程一直在，那么每次http请求进来时都是一个探活行动，直到dubbo服务重新起来，下一次请求就会完成探活&重试&重新初始化机制，并且完成后继续调用dubbo服务，给出http响应，只是这一次请求的耗时可以明显观测到。

3、中途注册中心集群全部挂掉怎么办？

> 只要该进程成功起来后，且dubbo服务运行正常，实质它已经完成了事前的初始化动作，跟注册中心没关系了，这种状态下不影响请求&响应，如果注册中心集群全部挂掉，且该进程重启了，那么无解，因为拉取不到dubbo服务元数据信息完成初始化。

4、如果进程运行期间，注册中心的服务列表有变化怎么办？

> 这只是个演示的demo，没有做动态监测注册中心的变动，但是生产环境上做了，保证服务元数据是最新的（允许有一定的异步更新），如果需要的话，可以自行去实现。

git地址见：https://github.com/994625905/ike_httpToDubbo
