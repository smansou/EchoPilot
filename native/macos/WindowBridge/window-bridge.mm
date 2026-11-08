#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <node_api.h>
// Only windows marked by this module bypass frame constraints. Normal app windows call the original implementation.
static const char edgeKey=0;
static IMP originalConstrain=nullptr;
static NSRect unconstrained(id self, SEL cmd, NSRect frame, NSScreen *screen) {
 if(objc_getAssociatedObject(self,&edgeKey))return frame;
 return ((NSRect(*)(id,SEL,NSRect,NSScreen*))originalConstrain)(self,cmd,frame,screen);
}
static napi_value configure(napi_env env,napi_callback_info info){
  size_t count=1; napi_value args[1]; napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  void *bytes=nullptr;size_t size=0;
  if(count!=1||napi_get_buffer_info(env,args[0],&bytes,&size)!=napi_ok||size<sizeof(void*)){napi_throw_type_error(env,nullptr,"Expected a native window handle");return nullptr;}
  if(![NSThread isMainThread]){napi_throw_error(env,nullptr,"Window setup must run on the main thread");return nullptr;}
  NSView *view=(__bridge NSView *)(*reinterpret_cast<void**>(bytes));NSWindow *window=view.window;
  if(!window){napi_throw_error(env,nullptr,"Overlay window is unavailable");return nullptr;}
  Class base=object_getClass(window);
  if(!originalConstrain){Method method=class_getInstanceMethod(base,@selector(constrainFrameRect:toScreen:));originalConstrain=method_getImplementation(method);class_addMethod(base,@selector(constrainFrameRect:toScreen:),originalConstrain,method_getTypeEncoding(method));class_replaceMethod(base,@selector(constrainFrameRect:toScreen:),(IMP)unconstrained,method_getTypeEncoding(method));}
  objc_setAssociatedObject(window,&edgeKey,@YES,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle;
  window.level=NSStatusWindowLevel+1;window.opaque=NO;window.backgroundColor=NSColor.clearColor;window.hasShadow=NO;window.hidesOnDeactivate=NO;
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
static napi_value inspect(napi_env env,napi_callback_info info){
 size_t count=1;napi_value args[1];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);void *bytes=nullptr;size_t size=0;if(count!=1||napi_get_buffer_info(env,args[0],&bytes,&size)!=napi_ok||size<sizeof(void*))return nullptr;
 NSView *view=(__bridge NSView *)(*reinterpret_cast<void**>(bytes));NSWindow *window=view.window;napi_value result;napi_create_object(env,&result);
 for(NSString *key in @[@"visible",@"fullScreenAuxiliary",@"allSpaces"]){BOOL value=[key isEqual:@"visible"]?(window.occlusionState&NSWindowOcclusionStateVisible)!=0:[key isEqual:@"allSpaces"]?(window.collectionBehavior&NSWindowCollectionBehaviorCanJoinAllSpaces)!=0:(window.collectionBehavior&NSWindowCollectionBehaviorFullScreenAuxiliary)!=0;napi_value boolean;napi_get_boolean(env,value,&boolean);napi_set_named_property(env,result,key.UTF8String,boolean);}
 return result;
}
static napi_value init(napi_env env,napi_value exports){napi_value fn;napi_create_function(env,"configure",NAPI_AUTO_LENGTH,configure,nullptr,&fn);napi_set_named_property(env,exports,"configure",fn);napi_create_function(env,"inspect",NAPI_AUTO_LENGTH,inspect,nullptr,&fn);napi_set_named_property(env,exports,"inspect",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
