import {FlowGRPCWeb, dpc, clearDPC} from '@aspectron/flow-grpc-web';
//const FlowGRPCWeb = new FlowGRPCWeb();
import {IRPC, RPC as Rpc,
	SubscriberItem, SubscriberItemMap,
	QueueItem, PendingReqs, IData, IStream
} from '../types/custom-types';

export interface DeferredPromise extends Promise<any> {
    resolve(data?:any):void;
    reject(error?:any):void;
}
export const Deferred = (): DeferredPromise=>{
    let methods = {};
    let promise = new Promise((resolve, reject)=>{
        methods = {resolve, reject};
    })
    Object.assign(promise, methods);
    return promise as DeferredPromise;
}

export class RPC implements IRPC{
	isReady:boolean = false;
	options:any;
	client:FlowGRPCWeb;
	reconnect_dpc:number|undefined;
	stream:IStream;
	queue:QueueItem[] = [];
	pending:PendingReqs;
	intakeHandler:Function|undefined;
	reconnect:boolean = true;
	verbose:boolean = false;
	subscribers: SubscriberItemMap = new Map();
	isConnected:boolean=false;
	connectCBs:Function[] = [];
	connectFailureCBs:Function[] = [];
	errorCBs:Function[] = [];
	disconnectCBs:Function[] = [];
	serviceClient:any;
	serviceClientSignal: DeferredPromise;
	log:Function;
	streamUid:string='';

	constructor(options:any={}){
		this.options = Object.assign({
			reconnect: true,
			verbose : true,
			uid:(Math.random()*1000).toFixed(0)
		}, options||{});

		this.log = Function.prototype.bind.call(
			console.log,
			console,
			`[Spectre gRPC ${this.options.uid}]:`
		);
		this.verbose = this.options.verbose;
		this.pending = {};
		this.reconnect = this.options.reconnect;
		this.client = new FlowGRPCWeb(options.clientConfig||{});

		this.serviceClientSignal = Deferred();

		this.client.on("ready", (clients:any)=>{
			console.log("gRPCWeb::::clients", clients)
			if(this.serviceClient){
				dpc(100, ()=>{
					this.reconnectStream();
				})
				return
			}
			let {RPC} = clients;
			this.serviceClient = RPC;
			this.serviceClientSignal.resolve();

			/*
			const stream = RPC.MessageStream();
			this.stream = stream;
			console.log("stream", stream)
			stream.on("end", ()=>{
				console.log("stream end")
			});
			this.initIntake(stream);
			*/
		})
		this.connect();
	}
	setStreamUid(uid:string){
		this.streamUid = uid;
	}
	async getServiceClient(){
		await this.serviceClientSignal;
		return this.serviceClient;
	}
	connect(){
		this.reconnect = true;
		return this.reconnectStream();
	}
	reconnectStream(){
		this._setConnected(false);
		if(this.reconnect_dpc) {
			clearDPC(this.reconnect_dpc);
			delete this.reconnect_dpc;
		}

		this.clearPending();
		delete this.stream;
		//delete this.client;
		if(this.reconnect) {
			this.reconnect_dpc = dpc(1000, () => {
				this._reconnectStream();
			})
		}
	}
	async _reconnectStream() {
		// this.reconnect = true;
		this.verbose && this.log('gRPC Client connecting to', this.options.clientConfig);
		const RPC = await this.getServiceClient();

		this.stream = RPC.MessageStream();
		this.initIntake(this.stream);
		this.isReady = true;
		this.processQueue();

		this.stream.on('error', (error:any) => {
			// console.log("client:",error);
			this.errorCBs.forEach(fn=>fn(error.toString(), error));
			this.verbose && this.log('stream:error', error);
			if(error?.code != 'TIMEOUT' || !this.isConnected)
				this.reconnectStream();
		})
		this.stream.on('end', (...args:any) => {
			this.verbose && this.log('stream:end', ...args);
			this.reconnectStream();
		});

		await new Promise<void>((resolve)=>{
			dpc(100, async()=>{
				let response:any = await this.request('getVirtualSelectedParentBlueScoreRequest', {})
				.catch(e=>{
					this.connectFailureCBs.forEach(fn=>fn(e));
				})
				this.verbose && this.log("getVirtualSelectedParentBlueScoreRequest:response", response)
				if(response && response.blueScore){
					this._setConnected(true);
				}
				resolve();
			})
		})
	}
	initIntake(stream:IStream) {
        stream.on('data',(data:any) => {
        	this.verbose && this.log("initIntake:data", "stream-id:"+stream.id, data)
            if(data.payload) {
                let name = data.payload;
                let payload = data[name];
                let ident = name.replace(/^get|Response$/ig,'').toLowerCase();
                this.handleIntake({name, payload, ident});
            }
        });
    }
    handleIntake(o:IData) {
        if(this.intakeHandler) {
            this.intakeHandler(o);
        } else {
            let handlers = this.pending[o.name];
            this.verbose && console.log('intake:',o,'handlers:',handlers);
            if(handlers && handlers.length){
            	let pendingItem:QueueItem|undefined = handlers.shift();
            	if(pendingItem)
                	pendingItem.resolve(o.payload);
            }

            let subscribers:SubscriberItem[]|undefined = this.subscribers.get(o.name);
			if(subscribers){
				subscribers.map(subscriber=>{
					subscriber.callback(o.payload)
				})
			}
        }
    }

    setIntakeHandler(fn:Function) {
        this.intakeHandler = fn;
    }
	processQueue(){
		if(!this.isReady || !this.streamUid)
			return

		let item:QueueItem|undefined = this.queue.shift();
		while(item){
			const resp = item.method.replace(/Request$/,'Response');
            if(!this.pending[resp])
                this.pending[resp] = [];
            let handlers:QueueItem[] = this.pending[resp];
            handlers.push(item);

			let req:any = {__streamuid__:this.streamUid};
			req[item.method] = item.data;
			this.stream.write(req);

			item = this.queue.shift();
		}
	}
	clearPending() {
        Object.keys(this.pending).forEach(key => {
            let list = this.pending[key];
            list.forEach(o=>o.reject('closing by force'));
            this.pending[key] = [];
        });
    }

    _setConnected(isConnected:boolean){
		if(this.isConnected == isConnected)
			return;
		this.verbose && this.log("_setConnected", this.isConnected, isConnected)
		this.isConnected = isConnected;

		let cbs = isConnected?this.connectCBs:this.disconnectCBs;
		//console.log("this.isConnected", this.isConnected, cbs)
		cbs.forEach(fn=>{
			fn();
		})
	}

	onConnect(callback:Function){
		this.connectCBs.push(callback)
		if(this.isConnected)
			callback();
	}
	onConnectFailure(callback:Function){
		this.connectFailureCBs.push(callback)
	}
	onError(callback:Function){
		this.errorCBs.push(callback)
	}
	onDisconnect(callback:Function){
		this.disconnectCBs.push(callback)
	}

	disconnect() {
		console.log("disconnect", this.stream?.id)
		if(this.reconnect_dpc) {
			clearDPC(this.reconnect_dpc);
			delete this.reconnect_dpc;
		}
		this.reconnect = false;
		this.stream && this.stream.end();
		this.clearPending();
	}
	request<T>(method:string, data:any){
		return new Promise<T>((resolve, reject)=>{
			this.queue.push({method, data, resolve, reject});
			this.processQueue();
		})
	}
    subscribe<T, R>(subject:string, data:any={}, callback:Rpc.callback<R>):Rpc.SubPromise<T>{
		if(typeof data == 'function'){
			callback = data;
			data = {};
		}

		if(!this.client)
			return Promise.reject('not connected') as Rpc.SubPromise<T>;

		let eventName = this.subject2EventName(subject);
		console.log("subscribe:eventName", eventName)

		let subscribers:SubscriberItem[]|undefined = this.subscribers.get(eventName);
		if(!subscribers){
			subscribers = [];
			this.subscribers.set(eventName, subscribers);
		}
		let uid = (Math.random()*100000 + Date.now()).toFixed(0);
		subscribers.push({uid, callback});

		let p = this.request(subject, data) as Rpc.SubPromise<T>;

		p.uid = uid;
		return p;
	}
	subject2EventName(subject:string){
		let eventName = subject.replace("notify", "").replace("Request", "Notification")
		return eventName[0].toLowerCase()+eventName.substr(1);
	}

	unSubscribe(subject:string, uid:string=''){
		let eventName = this.subject2EventName(subject);
		let subscribers:SubscriberItem[]|undefined = this.subscribers.get(eventName);
		if(!subscribers)
			return
		if(!uid){
			this.subscribers.delete(eventName);
		}else{
			subscribers = subscribers.filter(sub=>sub.uid!=uid)
			this.subscribers.set(eventName, subscribers);
		}
	}

	subscribeChainChanged(callback:Rpc.callback<Rpc.ChainChangedNotification>){
		return this.subscribe<Rpc.NotifyChainChangedResponse, Rpc.ChainChangedNotification>("notifyChainChangedRequest", {}, callback);
	}
	subscribeBlockAdded(callback:Rpc.callback<Rpc.BlockAddedNotification>){
		return this.subscribe<Rpc.NotifyBlockAddedResponse, Rpc.BlockAddedNotification>("notifyBlockAddedRequest", {}, callback);
	}
	subscribeVirtualSelectedParentBlueScoreChanged(callback:Rpc.callback<Rpc.VirtualSelectedParentBlueScoreChangedNotification>){
		return this.subscribe<Rpc.NotifyVirtualSelectedParentBlueScoreChangedResponse, Rpc.VirtualSelectedParentBlueScoreChangedNotification>("notifyVirtualSelectedParentBlueScoreChangedRequest", {}, callback);
	}

	subscribeUtxosChanged(addresses:string[], callback:Rpc.callback<Rpc.UtxosChangedNotification>){
		return this.subscribe<Rpc.NotifyUtxosChangedResponse, Rpc.UtxosChangedNotification>("notifyUtxosChangedRequest", {addresses}, callback);
	}

	unSubscribeUtxosChanged(uid:string=''){
		this.unSubscribe("notifyUtxosChangedRequest", uid);
	}

	getBlock(hash:string, includeTransactions:boolean=true){
		return this.request<Rpc.BlockResponse>('getBlockRequest', {hash, includeTransactions});
	}
	getTransactionsByAddresses(startingBlockHash:string, addresses:string[]){
		return this.request<Rpc.TransactionsByAddressesResponse>('getTransactionsByAddressesRequest', {
			startingBlockHash, addresses
		});
	}
	getUtxosByAddresses(addresses:string[]){
		return this.request<Rpc.UTXOsByAddressesResponse>('getUtxosByAddressesRequest', {addresses});
	}
	submitTransaction(tx: Rpc.SubmitTransactionRequest){
		return this.request<Rpc.SubmitTransactionResponse>('submitTransactionRequest', tx);
	}

	getVirtualSelectedParentBlueScore(){
		return this.request<Rpc.VirtualSelectedParentBlueScoreResponse>('getVirtualSelectedParentBlueScoreRequest', {});
	}

	getBlockDagInfo(){
		return this.request<Rpc.GetBlockDagInfoResponse>('getBlockDagInfoRequest', {});
	}
	subscribeVirtualDaaScoreChanged(callback:Rpc.callback<Rpc.VirtualDaaScoreChangedNotification>){
		return this.subscribe<Rpc.NotifyVirtualDaaScoreChangedResponse, Rpc.VirtualDaaScoreChangedNotification>("notifyVirtualDaaScoreChangedRequest", {}, callback);
	}
}
