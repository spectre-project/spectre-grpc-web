export type bytes = string;//base84 string
export * from './rpc';


export interface QueueItem{
	method:string,
	data:any,
	resolve:Function,
	reject:Function
}
export interface PendingReqs {
	[index:string]:QueueItem[];
}
export interface IData{
	name:string,
	payload:any,
	ident:string
}
export declare type IStream = any;

export interface SubscriberItem{
  uid:string;
  callback:function;
}

export declare type SubscriberItemMap = Map<string, SubscriberItem[]>;




